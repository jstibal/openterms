// POST /v1/simulate and GET /v1/simulate/{job_id}.
//
// Sync path only in this session: the corpus is 500 receipts and the
// async-threshold gate sits at 10,000. The 202 + GET-polling lifecycle is
// stubbed — see core/simulation_jobs.ts for the rationale.
//
// Candidate-policy handling:
//   • string  → 400 (policy-version lookup not implemented in this build)
//   • object  → parsed through policyFromDict and run through the engine

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import type { AppConfig } from '../config.js';
import { policyFromDict } from '../core/policy_types.js';
import type { Policy } from '../core/policy_types.js';
import { countReceiptsInWindow, runSimulation } from '../core/simulation.js';
import { getJob } from '../core/simulation_jobs.js';
import { errorBody } from '../lib/errors.js';

interface Deps {
  pool: Pool;
  config: AppConfig;
}

// Sync threshold — 10k receipts is comfortably under a 30s HTTP budget at
// our engine's per-receipt cost. Anything above this would return 202 and
// hand off to the async worker (not implemented in this session).
const SYNC_THRESHOLD = 10_000;
const DEFAULT_SAMPLE_SIZE = 100;
const MAX_SAMPLE_SIZE = 1000;

interface SimulateBody {
  candidate_policy?: unknown;
  from?: unknown;
  to?: unknown;
  sample_size?: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseIsoDate(
  v: unknown,
  field: string,
): { ok: true; date: Date } | { ok: false; msg: string } {
  if (typeof v !== 'string')
    return { ok: false, msg: `${field} must be an ISO-8601 date-time string` };
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    return { ok: false, msg: `${field} is not a valid ISO-8601 date-time` };
  return { ok: true, date: d };
}

interface ParsedRequest {
  candidatePolicy: Policy;
  from: Date;
  to: Date;
  sampleSize: number;
}

type ParseResult =
  | { ok: true; value: ParsedRequest }
  | { ok: false; status: number; code: 'VALIDATION_ERROR'; message: string; field?: string };

function parseSimulateRequest(body: SimulateBody): ParseResult {
  // candidate_policy: string ID lookup is explicitly unsupported here.
  if (typeof body.candidate_policy === 'string') {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      field: 'candidate_policy',
      message:
        'Policy lookup by version ID requires the /v1/policies endpoints which are not yet implemented in this build. Pass a PolicyInput object in candidate_policy instead. See IMPLEMENTATION_STATUS.md for the current endpoint coverage.',
    };
  }
  if (!isPlainObject(body.candidate_policy)) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      field: 'candidate_policy',
      message: 'candidate_policy must be a PolicyInput object',
    };
  }

  let candidatePolicy: Policy;
  try {
    // PolicyInput does not require `version`; policyFromDict defaults to
    // 'inline' when the caller omits it. Engine output therefore reports
    // policy_version='inline' for simulated decisions, which is what the
    // OpenAPI sample contract describes.
    candidatePolicy = policyFromDict(body.candidate_policy);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      field: 'candidate_policy',
      message: err instanceof Error ? err.message : 'candidate_policy is not a valid policy',
    };
  }

  const fromRes = parseIsoDate(body.from, 'from');
  if (!fromRes.ok) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      field: 'from',
      message: fromRes.msg,
    };
  }
  const toRes = parseIsoDate(body.to, 'to');
  if (!toRes.ok) {
    return { ok: false, status: 400, code: 'VALIDATION_ERROR', field: 'to', message: toRes.msg };
  }
  if (fromRes.date.getTime() > toRes.date.getTime()) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      field: 'to',
      message: 'to must be greater than or equal to from',
    };
  }

  let sampleSize = DEFAULT_SAMPLE_SIZE;
  if (body.sample_size !== undefined && body.sample_size !== null) {
    if (typeof body.sample_size !== 'number' || !Number.isInteger(body.sample_size)) {
      return {
        ok: false,
        status: 400,
        code: 'VALIDATION_ERROR',
        field: 'sample_size',
        message: 'sample_size must be an integer',
      };
    }
    if (body.sample_size < 0 || body.sample_size > MAX_SAMPLE_SIZE) {
      return {
        ok: false,
        status: 400,
        code: 'VALIDATION_ERROR',
        field: 'sample_size',
        message: `sample_size must be between 0 and ${MAX_SAMPLE_SIZE}`,
      };
    }
    sampleSize = body.sample_size;
  }

  return {
    ok: true,
    value: {
      candidatePolicy,
      from: fromRes.date,
      to: toRes.date,
      sampleSize,
    },
  };
}

export function registerSimulateRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/v1/simulate', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as SimulateBody;
    const parsed = parseSimulateRequest(body);
    if (!parsed.ok) {
      reply.status(parsed.status);
      return errorBody(
        parsed.code,
        parsed.message,
        parsed.field ? { field: parsed.field } : undefined,
      );
    }
    const { candidatePolicy, from, to, sampleSize } = parsed.value;

    // Sync/async gate: count first, then decide. The count is over the
    // requested [from, to] window — pre-window receipts read for
    // aggregate-state reconstruction (see simulation.ts) are an
    // implementation detail and don't influence the gate.
    const inWindowCount = await countReceiptsInWindow(deps.pool, deps.config.workspaceId, from, to);
    if (inWindowCount > SYNC_THRESHOLD) {
      // Async path is stubbed — surface a clean 400 rather than silently
      // pretending to enqueue. When async lands, this branch enqueues a
      // job and returns 202 with { job_id, status: 'queued' }.
      reply.status(400);
      return errorBody(
        'VALIDATION_ERROR',
        `Simulation window contains ${inWindowCount} receipts which exceeds the synchronous threshold of ${SYNC_THRESHOLD}. Async simulation is not yet implemented in this build; narrow the time range.`,
        { field: 'to', receipts_in_window: inWindowCount, sync_threshold: SYNC_THRESHOLD },
      );
    }

    const result = await runSimulation(deps.pool, {
      workspaceId: deps.config.workspaceId,
      candidatePolicy,
      from,
      to,
      sampleSize,
    });

    // Server-side reproducibility log: candidate policy + window + diff
    // count. The OpenAPI response schema does not include the candidate
    // policy in the body, so we log it instead of returning it.
    req.log.info(
      {
        candidate_policy_version: candidatePolicy.version,
        candidate_policy_rule_count: candidatePolicy.rules.length,
        from: from.toISOString(),
        to: to.toISOString(),
        receipts_evaluated: result.receipts_evaluated,
        total_diffs: result.diff_summary.total_diffs,
      },
      'simulation completed',
    );

    return result;
  });

  app.get(
    '/v1/simulate/:job_id',
    async (req: FastifyRequest<{ Params: { job_id: string } }>, reply: FastifyReply) => {
      const job = getJob(req.params.job_id);
      if (!job) {
        reply.status(404);
        return errorBody('NOT_FOUND', 'Simulation job not found.', { job_id: req.params.job_id });
      }
      return job;
    },
  );
}
