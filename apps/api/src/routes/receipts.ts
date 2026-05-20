import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { getActivePolicy, type AppConfig } from '../config.js';
import { evaluate } from '../core/policy.js';
import type { Decision } from '../core/policy_types.js';
import { verifyReceipt } from '../core/verify.js';
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
} from '../db/receipts.js';
import type { Pool } from 'pg';
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

// Run the policy engine against the receipt under the active policy. The
// engine is pure and only throws on malformed rule parameters or non-integer
// receipt amounts. Catch those and surface as an ENGINE_ERROR placeholder
// decision so receipt ingest is not blocked by a policy-author bug. Timeouts
// are NOT errors here — they are legitimate deny+TIMEOUT decisions returned
// from evaluate() and pass through unchanged.
function evaluateOrPlaceholder(
  receipt: Record<string, unknown>,
  config: AppConfig,
  log: FastifyRequest['log'],
): Decision {
  const policy = getActivePolicy(config);
  try {
    return evaluate(receipt, policy);
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
    // TODO(auth): bearer token verification belongs here, before any body
    // parsing. Deferred to a later session; documented in apps/api/README.md.

    const validation = validate(req.body);
    if (!validation.ok) {
      reply.status(400);
      return errorBody('VALIDATION_ERROR', validation.message, { field: validation.field });
    }
    const receipt = validation.receipt;

    if (receipt.workspace_id !== deps.config.workspaceId) {
      reply.status(400);
      return errorBody('VALIDATION_ERROR', 'workspace_id does not match this service instance', {
        field: 'workspace_id',
        received: receipt.workspace_id,
        expected: deps.config.workspaceId,
      });
    }

    const idempotencyKey = req.headers['idempotency-key'];
    const idempKey = typeof idempotencyKey === 'string' ? idempotencyKey : null;

    if (idempKey) {
      const priorHash = await lookupIdempotencyKey(deps.pool, deps.config.workspaceId, idempKey);
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
      return errorBody(mapped.code, verifyMessage(mapped.code), details);
    }

    // Single transaction: insert-receipt + insert-decision + record-idempotency.
    // If any of the three throws, ROLLBACK so we never end up with a stored
    // receipt without its associated decision (or vice versa).
    // TODO(daily-limit-aggregates): when daily_limit rules become active, this
    // is where we compute aggregates from the receipt log inside the same tx
    // (likely SUM(...) FOR UPDATE on receipts) before calling evaluate().
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
        const decision = evaluateOrPlaceholder(receipt, deps.config, req.log);
        const { stored: storedDecision } = await insertDecisionTx(
          client,
          stored.canonical_hash,
          deps.config.workspaceId,
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
          deps.config.workspaceId,
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

  app.get('/healthz', async () => ({ ok: true }));
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
