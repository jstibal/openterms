import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import type { AppConfig } from '../config.js';
import { storedDecisionToApi } from '../db/decisions.js';
import {
  aggregateReceipts,
  findReceiptByHashWithDecision,
  listReceipts,
  type ReceiptRow,
} from '../db/receipts.js';
import { errorBody } from '../lib/errors.js';
import { parseReceiptQuery } from './query_params.js';

interface Deps {
  pool: Pool;
  config: AppConfig;
}

const HEX64 = /^[0-9a-f]{64}$/;

function receiptRowToApi(row: ReceiptRow) {
  return {
    receipt: row.raw_receipt,
    hash: row.canonical_hash,
    ingested_at: row.ingested_at.toISOString(),
    decision: row.decision ? storedDecisionToApi(row.decision) : null,
  };
}

export function registerReceiptQueryRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/v1/receipts', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseReceiptQuery((req.query ?? {}) as Record<string, unknown>);
    if (!parsed.ok) {
      reply.status(400);
      return errorBody('VALIDATION_ERROR', parsed.error.message, { field: parsed.error.field });
    }
    const { filters, aggregate, limit, cursor } = parsed.value;
    const workspaceId = req.workspaceId ?? deps.config.workspaceId;

    if (aggregate !== 'none') {
      const agg = await aggregateReceipts(deps.pool, workspaceId, filters, aggregate);
      return agg;
    }

    const { rows, next_cursor } = await listReceipts(
      deps.pool,
      workspaceId,
      filters,
      cursor,
      limit,
    );
    return {
      receipts: rows.map(receiptRowToApi),
      next_cursor,
    };
  });

  app.get(
    '/v1/receipts/:hash',
    async (req: FastifyRequest<{ Params: { hash: string } }>, reply: FastifyReply) => {
      const hash = req.params.hash;
      if (!HEX64.test(hash)) {
        reply.status(400);
        return errorBody('VALIDATION_ERROR', 'hash must be 64 lowercase hex characters', {
          field: 'hash',
        });
      }
      const workspaceId = req.workspaceId ?? deps.config.workspaceId;
      const row = await findReceiptByHashWithDecision(deps.pool, workspaceId, hash);
      if (!row) {
        reply.status(404);
        return errorBody('NOT_FOUND', 'Receipt not found.', { hash });
      }
      return receiptRowToApi(row);
    },
  );
}
