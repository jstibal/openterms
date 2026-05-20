import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '../config.js';
import { verifyReceipt } from '../core/verify.js';
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
          reply.status(200);
          return {
            hash: stored.canonical_hash,
            ingested_at: stored.ingested_at.toISOString(),
            duplicate: true,
            receipt: stored.raw_receipt,
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

    const { stored, duplicate } = await insertReceipt(deps.pool, receipt);

    if (idempKey) {
      await recordIdempotencyKey(
        deps.pool,
        deps.config.workspaceId,
        idempKey,
        stored.canonical_hash,
      );
    }

    reply.status(duplicate ? 200 : 201);
    return {
      hash: stored.canonical_hash,
      ingested_at: stored.ingested_at.toISOString(),
      duplicate,
      receipt: stored.raw_receipt,
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
