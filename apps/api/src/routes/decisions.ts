import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import type { AppConfig } from '../config.js';
import { listDecisions, storedDecisionToApi } from '../db/decisions.js';
import { errorBody } from '../lib/errors.js';
import { parseDecisionQuery } from './query_params.js';

interface Deps {
  pool: Pool;
  config: AppConfig;
}

export function registerDecisionRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/v1/decisions', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseDecisionQuery((req.query ?? {}) as Record<string, unknown>);
    if (!parsed.ok) {
      reply.status(400);
      return errorBody('VALIDATION_ERROR', parsed.error.message, { field: parsed.error.field });
    }
    const { filters, limit, cursor } = parsed.value;

    const workspaceId = req.workspaceId ?? deps.config.workspaceId;
    const { rows, next_cursor } = await listDecisions(
      deps.pool,
      workspaceId,
      filters,
      cursor,
      limit,
    );

    return {
      decisions: rows.map((r) => ({
        ...storedDecisionToApi(r.stored),
        receipt_hash: r.stored.receipt_hash,
      })),
      next_cursor,
    };
  });
}
