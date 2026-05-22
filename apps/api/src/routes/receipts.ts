import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { getActivePolicy, type AppConfig } from '../config.js';
import { evaluate, verifyReceipt, type Decision } from '@openterms-ai/sdk';
import {
  findDecisionByReceiptHash,
  insertDecisionTx,
  storedDecisionToApi,
} from '../db/decisions.js';
import {
  findByCanonicalHash,
  insertReceipt,
  lookupIdempotencyKey,
  recordIdempotencyKey,
  recordVerificationError,
} from '../db/receipts.js';
import type { Pool, PoolClient } from 'pg';
import type { JwksLoader } from '../jwks/source.js';
import { errorBody, mapVerifyError } from '../lib/errors.js';

const REQUIRED_FIELDS = [
  'workspace_id',
  'agent_id',
  'action_type',
  'terms_url',
  'terms_hash',
  'timestamp',
  'pricing_version',
  'receipt_id',
  'amount_charged',
  'created_at',
  'canonical_hash',
  'signature',
  'key_id',
] as const;

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Deps {
  pool: Pool;
  config: AppConfig;
  loadJwks: JwksLoader;
}

function validate(
  body: unknown,
): { ok: true; receipt: Record<string, unknown> } | { ok: false; field: string; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, field: '<root>', message: 'Request body must be a JSON object' };
  }
  const receipt = body as Record<string, unknown>;
  for (const k of REQUIRED_FIELDS) {
    if (!(k in receipt) || receipt[k] === null || receipt[k] === undefined) {
      return { ok: false, field: k, message: `Receipt is missing required field '${k}'` };
    }
  }
  if (!UUID.test(receipt.workspace_id as string)) {
    return { ok: false, field: 'workspace_id', message: 'workspace_id must be a UUID' };
  }
  if (!UUID.test(receipt.receipt_id as string)) {
    return { ok: false, field: 'receipt_id', message: 'receipt_id must be a UUID' };
  }
  if (!HEX64.test(receipt.terms_hash as string)) {
    return { ok: false, field: 'terms_hash', message: 'terms_hash must be 64 lowercase hex chars' };
  }
  if (!HEX64.test(receipt.canonical_hash as string)) {
    return {
      ok: false,
      field: 'canonical_hash',
      message: 'canonical_hash must be 64 lowercase hex chars',
    };
  }
  if (typeof receipt.amount_charged !== 'number' || !Number.isInteger(receipt.amount_charged)) {
    return { ok: false, field: 'amount_charged', message: 'amount_charged must be an integer' };
  }
  return { ok: true, receipt };
}

// Compute the per-utc-day running total of amount_charged for this workspace,
// over receipts already stored at the same calendar UTC day as `receiptTs`,
// excluding the current receipt (it is not yet inserted at call time).
// Matches the aggregate shape the simulation engine builds — a single per-day
// bucket assigned to every daily_limit rule id. The query runs inside the
// ingest transaction so concurrent inserts are serialized by row locks on the
// scanned range (the receipts table is append-only).
async function computeDailyLimitAggregates(
  client: PoolClient,
  workspaceId: string,
  receiptTs: string,
  dailyLimitRuleIds: string[],
): Promise<Record<string, number>> {
  if (dailyLimitRuleIds.length === 0) return {};
  const ts = new Date(receiptTs);
  if (Number.isNaN(ts.getTime())) return {};
  // [dayStart, dayEnd) — start-inclusive, end-exclusive UTC day window.
  const dayStart = new Date(Date.UTC(ts.getUTCFullYear(), ts.getUTCMonth(), ts.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const result = await client.query(
    `SELECT COALESCE(SUM(amount_charged), 0)::bigint AS total
       FROM receipts
      WHERE workspace_id = $1 AND ts >= $2 AND ts < $3`,
    [workspaceId, dayStart.toISOString(), dayEnd.toISOString()],
  );
  const total = Number(result.rows[0]?.total ?? 0);
  const aggs: Record<string, number> = {};
  for (const id of dailyLimitRuleIds) aggs[id] = total;
  return aggs;
}

// Run the policy engine against the receipt under the active policy. The
// engine is pure and only throws on malformed rule parameters or non-integer
// receipt amounts. Catch those and surface as an ENGINE_ERROR placeholder
// decision so receipt ingest is not blocked by a policy-author bug. Timeouts
// are NOT errors here — they are legitimate deny+TIMEOUT decisions returned
// from evaluate() and pass through unchanged.
//
// ENGINE_ERROR semantics. We INTENTIONALLY convert engine exceptions into a
// stored deny decision (reason `ENGINE_ERROR: <message>`) rather than 5xx-ing
// the ingest call. The receipt is still verified and persisted, and the
// failure is auditable on the decisions row. Rationale: a misconfigured rule
// in the active policy must not take the ingest path offline — the agent
// already produced a signed receipt and we need to capture it. Operators
// detect engine errors by querying decisions WHERE reasons @> ARRAY['ENGINE_ERROR%'].
// Trade-off: this conflates "policy returned deny" with "engine bug returned
// deny" in the same column. Acceptable for v1; a dedicated
// policy_evaluation_errors table is the right fix if/when that conflation
// becomes load-bearing for operators.
function evaluateOrPlaceholder(
  receipt: Record<string, unknown>,
  config: AppConfig,
  log: FastifyRequest['log'],
  aggregates: Record<string, number>,
): Decision {
  const policy = getActivePolicy(config);
  try {
    return evaluate(receipt, policy, { aggregates });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, policy_version: policy.version }, 'policy engine error');
    const evaluatedAt =
      (typeof receipt.created_at === 'string' && receipt.created_at) ||
      (typeof receipt.timestamp === 'string' && (receipt.timestamp as string)) ||
      '1970-01-01T00:00:00Z';
    return {
      decision: 'deny',
      triggered_rules: [],
      reasons: [`ENGINE_ERROR: ${message}`],
      policy_version: policy.version,
      evaluated_at: evaluatedAt,
    };
  }
}

export function registerReceiptRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/v1/receipts/ingest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Auth: handled by the bearer-auth onRequest hook registered in
    // server.ts. By this point req.workspaceId is set (or the dev fallback
    // applied in non-production environments).
    const workspaceId = req.workspaceId ?? deps.config.workspaceId;

    const validation = validate(req.body);
    if (!validation.ok) {
      reply.status(400);
      return errorBody('VALIDATION_ERROR', validation.message, { field: validation.field });
    }
    const receipt = validation.receipt;

    if (receipt.workspace_id !== workspaceId) {
      reply.status(400);
      return errorBody('VALIDATION_ERROR', 'workspace_id does not match this service instance', {
        field: 'workspace_id',
        received: receipt.workspace_id,
        expected: workspaceId,
      });
    }

    const idempotencyKey = req.headers['idempotency-key'];
    const idempKey = typeof idempotencyKey === 'string' ? idempotencyKey : null;

    if (idempKey) {
      const priorHash = await lookupIdempotencyKey(deps.pool, workspaceId, idempKey);
      if (priorHash && priorHash !== receipt.canonical_hash) {
        reply.status(409);
        return errorBody(
          'IDEMPOTENCY_KEY_CONFLICT',
          'An earlier request with this Idempotency-Key was processed with a different payload.',
          { idempotency_key: idempKey },
        );
      }
      if (priorHash && priorHash === receipt.canonical_hash) {
        const stored = await findByCanonicalHash(deps.pool, priorHash);
        if (stored) {
          const existingDecision = await findDecisionByReceiptHash(deps.pool, priorHash);
          reply.status(200);
          return {
            hash: stored.canonical_hash,
            ingested_at: stored.ingested_at.toISOString(),
            duplicate: true,
            receipt: stored.raw_receipt,
            ...(existingDecision ? { decision: storedDecisionToApi(existingDecision) } : {}),
          };
        }
      }
    }

    const jwks = await deps.loadJwks();
    const result = verifyReceipt(receipt, jwks);
    if (!result.valid && result.error) {
      const mapped = mapVerifyError(result.error);
      reply.status(mapped.httpStatus);
      const details: Record<string, unknown> = { key_id: result.keyId };
      if (result.error === 'HASH_MISMATCH') {
        details.expected = receipt.canonical_hash;
        details.computed = result.canonicalHash;
      }
      details.verify_error = result.error;
      // Persist to the queryable failure stream. Best-effort: a write
      // failure here must not change the user-visible response.
      try {
        await recordVerificationError(deps.pool, {
          workspaceId: workspaceId,
          claimedHash: typeof receipt.canonical_hash === 'string' ? receipt.canonical_hash : null,
          errorCode: result.error,
          details,
          receiptBody: req.body,
        });
      } catch (err) {
        req.log.warn({ err }, 'failed to persist verification_errors row');
      }
      return errorBody(mapped.code, verifyMessage(mapped.code), details);
    }

    // Single transaction: aggregate-compute + insert-receipt + insert-decision
    // + record-idempotency. If any throws, ROLLBACK so we never end up with a
    // stored receipt without its associated decision (or vice versa).
    const client = await deps.pool.connect();
    let stored;
    let duplicate;
    let decisionForResponse: Decision | null = null;
    try {
      await client.query('BEGIN');
      const ins = await insertReceipt(client, receipt);
      stored = ins.stored;
      duplicate = ins.duplicate;

      if (!duplicate) {
        const activePolicy = getActivePolicy(deps.config);
        const dailyLimitRuleIds = activePolicy.rules
          .filter((r) => r.type === 'daily_limit')
          .map((r) => r.id);
        const aggregates = await computeDailyLimitAggregates(
          client,
          workspaceId,
          typeof receipt.timestamp === 'string' ? receipt.timestamp : new Date().toISOString(),
          dailyLimitRuleIds,
        );
        const decision = evaluateOrPlaceholder(receipt, deps.config, req.log, aggregates);
        const { stored: storedDecision } = await insertDecisionTx(
          client,
          stored.canonical_hash,
          workspaceId,
          decision,
        );
        decisionForResponse = storedDecisionToApi(storedDecision);
      } else {
        // Replay of a payload we ingested before — surface the prior decision.
        const prior = await findDecisionByReceiptHash(client, stored.canonical_hash);
        decisionForResponse = prior ? storedDecisionToApi(prior) : null;
      }

      if (idempKey) {
        await recordIdempotencyKey(
          client,
          workspaceId,
          idempKey,
          stored.canonical_hash,
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        // ignore; original error is what matters
      });
      throw err;
    } finally {
      client.release();
    }

    reply.status(duplicate ? 200 : 201);
    return {
      hash: stored.canonical_hash,
      ingested_at: stored.ingested_at.toISOString(),
      duplicate,
      receipt: stored.raw_receipt,
      ...(decisionForResponse ? { decision: decisionForResponse } : {}),
    };
  });

}

function verifyMessage(code: string): string {
  switch (code) {
    case 'HASH_MISMATCH':
      return 'Recomputed canonical hash does not match the value in the receipt.';
    case 'SIGNATURE_INVALID':
      return 'Ed25519 signature failed to verify against the workspace JWKS public key.';
    case 'UNKNOWN_ISSUER':
      return 'The key_id on the receipt does not match a usable key in the workspace JWKS.';
    default:
      return 'Receipt verification failed.';
  }
}
