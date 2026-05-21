import type { Pool, PoolClient } from 'pg';

import type { AggregateBucket, AggregateMode, Filters, ParsedCursor } from './query_types.js';
import { encodeCursor } from './query_types.js';
import type { StoredDecision } from './decisions.js';

export type Queryable = Pool | PoolClient;

export interface StoredReceipt {
  canonical_hash: string;
  raw_receipt: Record<string, unknown>;
  ingested_at: Date;
}

interface InsertRow {
  canonical_hash: string;
  signature: string;
  key_id: string;
  workspace_id: string;
  agent_id: string;
  action_type: string;
  terms_url: string;
  terms_hash: string;
  ts: string;
  pricing_version: string;
  receipt_id: string;
  amount_charged: number;
  receipt_created_at: string;
  action_context: unknown;
  ors_version: string | null;
  issuer: string | null;
  provider: unknown;
  decision: unknown;
  request_binding: unknown;
  terms_type: string | null;
  terms_service: string | null;
  terms_version: string | null;
  raw_receipt: Record<string, unknown>;
}

export function rowFromReceipt(receipt: Record<string, unknown>): InsertRow {
  const pick = <T>(k: string): T | null =>
    receipt[k] === undefined || receipt[k] === null ? null : (receipt[k] as T);
  const jsonOrNull = (v: unknown) => (v === undefined || v === null ? null : v);
  return {
    canonical_hash: receipt.canonical_hash as string,
    signature: receipt.signature as string,
    key_id: receipt.key_id as string,
    workspace_id: receipt.workspace_id as string,
    agent_id: receipt.agent_id as string,
    action_type: receipt.action_type as string,
    terms_url: receipt.terms_url as string,
    terms_hash: receipt.terms_hash as string,
    ts: receipt.timestamp as string,
    pricing_version: receipt.pricing_version as string,
    receipt_id: receipt.receipt_id as string,
    amount_charged: receipt.amount_charged as number,
    receipt_created_at: receipt.created_at as string,
    action_context: jsonOrNull(receipt.action_context),
    ors_version: pick<string>('ors_version'),
    issuer: pick<string>('issuer'),
    provider: jsonOrNull(receipt.provider),
    decision: jsonOrNull(receipt.decision),
    request_binding: jsonOrNull(receipt.request_binding),
    terms_type: pick<string>('terms_type'),
    terms_service: pick<string>('terms_service'),
    terms_version: pick<string>('terms_version'),
    raw_receipt: receipt,
  };
}

const INSERT_SQL = `
INSERT INTO receipts (
  canonical_hash, signature, key_id,
  workspace_id, agent_id, action_type, terms_url, terms_hash, ts, pricing_version,
  receipt_id, amount_charged, receipt_created_at,
  action_context, ors_version, issuer, provider, decision, request_binding,
  terms_type, terms_service, terms_version,
  raw_receipt
) VALUES (
  $1, $2, $3,
  $4, $5, $6, $7, $8, $9, $10,
  $11, $12, $13,
  $14::jsonb, $15, $16, $17::jsonb, $18::jsonb, $19::jsonb,
  $20, $21, $22,
  $23::jsonb
)
ON CONFLICT (canonical_hash) DO NOTHING
RETURNING canonical_hash, raw_receipt, ingested_at
`;

export async function insertReceipt(
  q: Queryable,
  receipt: Record<string, unknown>,
): Promise<{ stored: StoredReceipt; duplicate: boolean }> {
  const r = rowFromReceipt(receipt);
  const result = await q.query(INSERT_SQL, [
    r.canonical_hash,
    r.signature,
    r.key_id,
    r.workspace_id,
    r.agent_id,
    r.action_type,
    r.terms_url,
    r.terms_hash,
    r.ts,
    r.pricing_version,
    r.receipt_id,
    r.amount_charged,
    r.receipt_created_at,
    r.action_context === null ? null : JSON.stringify(r.action_context),
    r.ors_version,
    r.issuer,
    r.provider === null ? null : JSON.stringify(r.provider),
    r.decision === null ? null : JSON.stringify(r.decision),
    r.request_binding === null ? null : JSON.stringify(r.request_binding),
    r.terms_type,
    r.terms_service,
    r.terms_version,
    JSON.stringify(r.raw_receipt),
  ]);

  if (result.rowCount && result.rowCount > 0) {
    const row = result.rows[0]!;
    return {
      stored: {
        canonical_hash: row.canonical_hash,
        raw_receipt: row.raw_receipt,
        ingested_at: row.ingested_at,
      },
      duplicate: false,
    };
  }

  const existing = await findByCanonicalHash(q, r.canonical_hash);
  if (!existing) throw new Error('insert conflict but row not found');
  return { stored: existing, duplicate: true };
}

export async function findByCanonicalHash(
  q: Queryable,
  canonicalHash: string,
): Promise<StoredReceipt | null> {
  const result = await q.query(
    'SELECT canonical_hash, raw_receipt, ingested_at FROM receipts WHERE canonical_hash = $1',
    [canonicalHash],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0]!;
  return {
    canonical_hash: row.canonical_hash,
    raw_receipt: row.raw_receipt,
    ingested_at: row.ingested_at,
  };
}

// ---------------------------------------------------------------------------
// Query layer (list, aggregate, single fetch with joined decision).
//
// SQL safety: every user-supplied filter value is bound to a numbered
// parameter ($N). The composition functions only emit static SQL fragments
// that reference those placeholders — no value ever appears inline in SQL.
// ---------------------------------------------------------------------------

export interface ReceiptRow {
  canonical_hash: string;
  raw_receipt: Record<string, unknown>;
  ingested_at: Date;
  ts: Date;
  receipt_id: string;
  decision: StoredDecision | null;
}

export interface ListReceiptsResult {
  rows: ReceiptRow[];
  next_cursor: string | null;
}

type Bindings = unknown[];

// Filters that require reading from `decisions` force the LEFT JOIN to an
// INNER JOIN. We choose the join type up front and generate explicit SQL
// rather than relying on Postgres to deduce equivalence from WHERE clauses.
function needsInnerJoin(f: Filters): boolean {
  return f.decision !== undefined || f.triggered_rule !== undefined || f.q !== undefined;
}

// Build the WHERE clause fragment for the shared receipt+decision filter set,
// appending each value to `bindings` and emitting parameter placeholders.
function buildFilterClauses(
  f: Filters,
  bindings: Bindings,
  opts: { includeDecisionFilters: boolean },
): string[] {
  const clauses: string[] = [];
  const push = (v: unknown): string => {
    bindings.push(v);
    return `$${bindings.length}`;
  };

  if (f.agent_id !== undefined) clauses.push(`r.agent_id = ${push(f.agent_id)}`);
  if (f.action_type !== undefined) clauses.push(`r.action_type = ${push(f.action_type)}`);
  if (f.tool_id !== undefined) {
    clauses.push(`r.action_context->'ors'->'commitments'->>'tool_id' = ${push(f.tool_id)}`);
  }
  if (f.chain_id !== undefined) {
    clauses.push(`r.action_context->'ors'->'chain'->>'chain_id' = ${push(f.chain_id)}`);
  }
  if (f.issuer !== undefined) clauses.push(`r.issuer = ${push(f.issuer)}`);
  if (f.from !== undefined) clauses.push(`r.ts >= ${push(f.from)}`);
  if (f.to !== undefined) clauses.push(`r.ts <= ${push(f.to)}`);

  if (opts.includeDecisionFilters) {
    if (f.decision !== undefined) clauses.push(`d.decision = ${push(f.decision)}`);
    if (f.triggered_rule !== undefined) {
      clauses.push(`d.triggered_rules ? ${push(f.triggered_rule)}`);
    }
    if (f.policy_version !== undefined) {
      clauses.push(`d.policy_version = ${push(f.policy_version)}`);
    }
    if (f.q !== undefined) {
      clauses.push(
        `EXISTS (SELECT 1 FROM jsonb_array_elements_text(d.reasons) reason WHERE reason ILIKE ${push('%' + f.q + '%')})`,
      );
    }
  }

  return clauses;
}

const RECEIPT_SELECT_COLS = `
  r.canonical_hash, r.raw_receipt, r.ingested_at, r.ts, r.receipt_id,
  d.receipt_hash    AS d_receipt_hash,
  d.workspace_id    AS d_workspace_id,
  d.decision        AS d_decision,
  d.triggered_rules AS d_triggered_rules,
  d.reasons         AS d_reasons,
  d.policy_version  AS d_policy_version,
  d.evaluated_at    AS d_evaluated_at,
  d.created_at      AS d_created_at
`;

function rowToReceiptRow(row: Record<string, unknown>): ReceiptRow {
  const hasDecision = row.d_decision !== null && row.d_decision !== undefined;
  return {
    canonical_hash: row.canonical_hash as string,
    raw_receipt: row.raw_receipt as Record<string, unknown>,
    ingested_at: row.ingested_at as Date,
    ts: row.ts as Date,
    receipt_id: row.receipt_id as string,
    decision: hasDecision
      ? {
          receipt_hash: row.d_receipt_hash as string,
          workspace_id: row.d_workspace_id as string,
          decision: row.d_decision as StoredDecision['decision'],
          triggered_rules: row.d_triggered_rules as string[],
          reasons: row.d_reasons as string[],
          policy_version: row.d_policy_version as string,
          evaluated_at: row.d_evaluated_at as Date,
          created_at: row.d_created_at as Date,
        }
      : null,
  };
}

export async function listReceipts(
  q: Queryable,
  workspaceId: string,
  filters: Filters,
  cursor: ParsedCursor | null,
  limit: number,
): Promise<ListReceiptsResult> {
  const bindings: Bindings = [];
  const push = (v: unknown): string => {
    bindings.push(v);
    return `$${bindings.length}`;
  };

  const where: string[] = [`r.workspace_id = ${push(workspaceId)}`];
  where.push(...buildFilterClauses(filters, bindings, { includeDecisionFilters: true }));

  // Cursor is strict `<` over (ts, receipt_id) so concurrent inserts at higher
  // timestamps do not appear on later pages, preventing duplicates across the
  // boundary. New inserts at lower timestamps may legitimately appear on a
  // later page; that is acceptable for an append-only log.
  if (cursor) {
    const t = push(cursor.t);
    const i = push(cursor.i);
    where.push(`(r.ts, r.receipt_id) < (${t}, ${i})`);
  }

  const join = needsInnerJoin(filters) ? 'INNER JOIN' : 'LEFT JOIN';
  const limitPlus1 = push(limit + 1);

  const sql = `
    SELECT ${RECEIPT_SELECT_COLS}
    FROM receipts r
    ${join} decisions d ON d.receipt_hash = r.canonical_hash
    WHERE ${where.join(' AND ')}
    ORDER BY r.ts DESC, r.receipt_id DESC
    LIMIT ${limitPlus1}
  `;

  const result = await q.query(sql, bindings);
  const rows = result.rows.map(rowToReceiptRow);

  let next_cursor: string | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1]!;
    rows.splice(limit);
    next_cursor = encodeCursor({ t: last.ts.toISOString(), i: last.receipt_id });
  }

  return { rows, next_cursor };
}

export async function findReceiptByHashWithDecision(
  q: Queryable,
  workspaceId: string,
  hash: string,
): Promise<ReceiptRow | null> {
  const sql = `
    SELECT ${RECEIPT_SELECT_COLS}
    FROM receipts r
    LEFT JOIN decisions d ON d.receipt_hash = r.canonical_hash
    WHERE r.workspace_id = $1 AND r.canonical_hash = $2
  `;
  const result = await q.query(sql, [workspaceId, hash]);
  if (result.rowCount === 0) return null;
  return rowToReceiptRow(result.rows[0]!);
}

// Aggregation reads decision columns only for count_by_decision and
// count_by_rule; the other modes can stay on the LEFT JOIN. We still promote
// to INNER JOIN if a decision-side filter (decision / triggered_rule / q) is
// in play, so the count is consistent with the matching list query.
export async function aggregateReceipts(
  q: Queryable,
  workspaceId: string,
  filters: Filters,
  mode: Exclude<AggregateMode, 'none'>,
): Promise<{ dimension: string; buckets: AggregateBucket[] }> {
  const bindings: Bindings = [];
  const push = (v: unknown): string => {
    bindings.push(v);
    return `$${bindings.length}`;
  };

  const where: string[] = [`r.workspace_id = ${push(workspaceId)}`];
  where.push(...buildFilterClauses(filters, bindings, { includeDecisionFilters: true }));

  const readsDecisionCols = mode === 'count_by_decision' || mode === 'count_by_rule';
  const join = needsInnerJoin(filters) || readsDecisionCols ? 'INNER JOIN' : 'LEFT JOIN';

  let selectExpr: string;
  let groupBy: string;
  let orderBy: string;
  let extraFrom = '';
  let dimension: string;

  switch (mode) {
    case 'count_by_decision':
      selectExpr = 'd.decision::text AS key';
      groupBy = 'd.decision';
      orderBy = 'count DESC, key ASC';
      dimension = 'decision';
      break;
    case 'count_by_rule':
      // Cross-join unnest of the triggered_rules JSONB array. Receipts whose
      // decision has zero triggered rules contribute nothing — they are not
      // attributable to any rule.
      extraFrom = ', jsonb_array_elements_text(d.triggered_rules) AS rule';
      selectExpr = 'rule AS key';
      groupBy = 'rule';
      orderBy = 'count DESC, key ASC';
      dimension = 'rule';
      break;
    case 'count_by_tool':
      selectExpr = "r.action_context->'ors'->'commitments'->>'tool_id' AS key";
      groupBy = "r.action_context->'ors'->'commitments'->>'tool_id'";
      // Filter out NULL tool_ids — a receipt with no commitments has no tool.
      where.push(`r.action_context->'ors'->'commitments'->>'tool_id' IS NOT NULL`);
      orderBy = 'count DESC, key ASC';
      dimension = 'tool';
      break;
    case 'count_by_agent':
      selectExpr = 'r.agent_id AS key';
      groupBy = 'r.agent_id';
      orderBy = 'count DESC, key ASC';
      dimension = 'agent';
      break;
    case 'count_by_hour':
      selectExpr =
        "to_char(date_trunc('hour', r.ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD\"T\"HH24:00:00\"Z\"') AS key";
      groupBy = "date_trunc('hour', r.ts AT TIME ZONE 'UTC')";
      orderBy = 'key ASC';
      dimension = 'hour';
      break;
    case 'count_by_day':
      selectExpr = "to_char(date_trunc('day', r.ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS key";
      groupBy = "date_trunc('day', r.ts AT TIME ZONE 'UTC')";
      orderBy = 'key ASC';
      dimension = 'day';
      break;
  }

  const sql = `
    SELECT ${selectExpr}, COUNT(*)::bigint AS count
    FROM receipts r
    ${join} decisions d ON d.receipt_hash = r.canonical_hash
    ${extraFrom}
    WHERE ${where.join(' AND ')}
    GROUP BY ${groupBy}
    ORDER BY ${orderBy}
  `;

  const result = await q.query(sql, bindings);
  const buckets: AggregateBucket[] = result.rows.map((row: Record<string, unknown>) => ({
    key: String(row.key),
    count: Number(row.count),
  }));
  return { dimension, buckets };
}

export async function recordIdempotencyKey(
  q: Queryable,
  workspaceId: string,
  key: string,
  canonicalHash: string,
): Promise<void> {
  await q.query(
    `INSERT INTO idempotency_keys (workspace_id, idempotency_key, canonical_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [workspaceId, key, canonicalHash],
  );
}

export async function lookupIdempotencyKey(
  q: Queryable,
  workspaceId: string,
  key: string,
): Promise<string | null> {
  const result = await q.query(
    'SELECT canonical_hash FROM idempotency_keys WHERE workspace_id = $1 AND idempotency_key = $2',
    [workspaceId, key],
  );
  if (result.rowCount === 0) return null;
  return result.rows[0]!.canonical_hash as string;
}

// Cap to keep a malformed-or-malicious receipt from blowing up the table.
const VERR_SNIPPET_LIMIT = 4096;

export async function recordVerificationError(
  q: Queryable,
  args: {
    workspaceId: string;
    claimedHash: string | null;
    errorCode: string;
    details: Record<string, unknown> | null;
    receiptBody: unknown;
  },
): Promise<void> {
  let snippet: string | null = null;
  try {
    const serialized = typeof args.receiptBody === 'string'
      ? args.receiptBody
      : JSON.stringify(args.receiptBody);
    if (serialized) {
      snippet = serialized.length > VERR_SNIPPET_LIMIT
        ? serialized.slice(0, VERR_SNIPPET_LIMIT)
        : serialized;
    }
  } catch {
    snippet = null;
  }
  await q.query(
    `INSERT INTO verification_errors
       (workspace_id, claimed_hash, error_code, details, receipt_snippet)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      args.workspaceId,
      args.claimedHash,
      args.errorCode,
      args.details ? JSON.stringify(args.details) : null,
      snippet,
    ],
  );
}
