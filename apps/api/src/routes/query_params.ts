// Shared query-parameter parsing and validation for the receipt and decision
// query endpoints (GET /v1/receipts, GET /v1/receipts/{hash}, GET /v1/decisions).
//
// All user-supplied filter values flow through here on their way to the
// storage layer, where they are bound to pg parameter placeholders ($1, $2,
// ...). No filter value is ever interpolated into SQL — the SQL builders only
// compose static fragments referring to placeholder indices.

import type {
  AggregateMode,
  DecisionOutcome,
  Filters,
  ParsedCursor,
  ReceiptActionType,
} from '../db/query_types.js';
import { decodeCursor } from '../db/query_types.js';

export type { Filters, ParsedCursor } from '../db/query_types.js';
export { encodeCursor } from '../db/query_types.js';

const VALID_ACTION_TYPES: ReceiptActionType[] = [
  'api_call',
  'data_access',
  'purchase',
  'custom',
  'model_training',
];

const VALID_DECISIONS: DecisionOutcome[] = ['allow', 'deny', 'escalate'];

const VALID_AGGREGATES: AggregateMode[] = [
  'none',
  'count_by_decision',
  'count_by_rule',
  'count_by_tool',
  'count_by_agent',
  'count_by_hour',
  'count_by_day',
];

export interface ReceiptQueryParams {
  filters: Filters;
  aggregate: AggregateMode;
  limit: number;
  cursor: ParsedCursor | null;
}

export interface DecisionQueryParams {
  filters: Filters;
  limit: number;
  cursor: ParsedCursor | null;
}

export type ParseError = { field: string; message: string };
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ParseError };

function takeString(q: Record<string, unknown>, name: string): string | undefined {
  const v = q[name];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') return undefined;
  return v;
}

function parseLimit(raw: unknown): ParseResult<number> {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: 50 };
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: { field: 'limit', message: 'limit must be an integer' } };
  }
  if (n < 1 || n > 200) {
    return { ok: false, error: { field: 'limit', message: 'limit must be between 1 and 200' } };
  }
  return { ok: true, value: n };
}

function parseIsoDate(raw: string, field: string): ParseResult<string> {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return { ok: false, error: { field, message: `${field} must be an ISO 8601 datetime` } };
  }
  return { ok: true, value: d.toISOString() };
}

function parseFilters(
  q: Record<string, unknown>,
  opts: { allowPolicyVersion: boolean },
): ParseResult<Filters> {
  const f: Filters = {};

  const agentId = takeString(q, 'agent_id');
  if (agentId !== undefined) f.agent_id = agentId;

  const actionType = takeString(q, 'action_type');
  if (actionType !== undefined) {
    if (!VALID_ACTION_TYPES.includes(actionType as ReceiptActionType)) {
      return {
        ok: false,
        error: {
          field: 'action_type',
          message: `action_type must be one of ${VALID_ACTION_TYPES.join(', ')}`,
        },
      };
    }
    f.action_type = actionType as ReceiptActionType;
  }

  const toolId = takeString(q, 'tool_id');
  if (toolId !== undefined) f.tool_id = toolId;

  const decision = takeString(q, 'decision');
  if (decision !== undefined) {
    if (!VALID_DECISIONS.includes(decision as DecisionOutcome)) {
      return {
        ok: false,
        error: {
          field: 'decision',
          message: `decision must be one of ${VALID_DECISIONS.join(', ')}`,
        },
      };
    }
    f.decision = decision as DecisionOutcome;
  }

  const triggeredRule = takeString(q, 'triggered_rule');
  if (triggeredRule !== undefined) f.triggered_rule = triggeredRule;

  const chainId = takeString(q, 'chain_id');
  if (chainId !== undefined) f.chain_id = chainId;

  const issuer = takeString(q, 'issuer');
  if (issuer !== undefined) f.issuer = issuer;

  if (opts.allowPolicyVersion) {
    const pv = takeString(q, 'policy_version');
    if (pv !== undefined) f.policy_version = pv;
  }

  const from = takeString(q, 'from');
  if (from !== undefined) {
    const r = parseIsoDate(from, 'from');
    if (!r.ok) return r;
    f.from = r.value;
  }

  const to = takeString(q, 'to');
  if (to !== undefined) {
    const r = parseIsoDate(to, 'to');
    if (!r.ok) return r;
    f.to = r.value;
  }

  const qStr = takeString(q, 'q');
  if (qStr !== undefined) f.q = qStr;

  return { ok: true, value: f };
}

export function parseReceiptQuery(q: Record<string, unknown>): ParseResult<ReceiptQueryParams> {
  const filters = parseFilters(q, { allowPolicyVersion: false });
  if (!filters.ok) return filters;

  const aggRaw = takeString(q, 'aggregate') ?? 'none';
  if (!VALID_AGGREGATES.includes(aggRaw as AggregateMode)) {
    return {
      ok: false,
      error: {
        field: 'aggregate',
        message: `aggregate must be one of ${VALID_AGGREGATES.join(', ')}`,
      },
    };
  }
  const aggregate = aggRaw as AggregateMode;

  const limit = parseLimit(q.limit);
  if (!limit.ok) return limit;

  const cursorRaw = takeString(q, 'cursor');
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;

  return {
    ok: true,
    value: { filters: filters.value, aggregate, limit: limit.value, cursor },
  };
}

export function parseDecisionQuery(q: Record<string, unknown>): ParseResult<DecisionQueryParams> {
  const filters = parseFilters(q, { allowPolicyVersion: true });
  if (!filters.ok) return filters;

  const limit = parseLimit(q.limit);
  if (!limit.ok) return limit;

  const cursorRaw = takeString(q, 'cursor');
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;

  return { ok: true, value: { filters: filters.value, limit: limit.value, cursor } };
}
