import type { Pool, PoolClient } from 'pg';

import type { Decision } from '../core/policy_types.js';
import type { Filters, ParsedCursor } from './query_types.js';
import { encodeCursor } from './query_types.js';

export type Queryable = Pool | PoolClient;

export interface StoredDecision {
  receipt_hash: string;
  workspace_id: string;
  decision: 'allow' | 'deny' | 'escalate';
  triggered_rules: string[];
  reasons: string[];
  policy_version: string;
  evaluated_at: Date;
  created_at: Date;
}

const INSERT_SQL = `
INSERT INTO decisions (
  receipt_hash, workspace_id, decision,
  triggered_rules, reasons,
  policy_version, evaluated_at
) VALUES (
  $1, $2, $3,
  $4::jsonb, $5::jsonb,
  $6, $7
)
ON CONFLICT (receipt_hash) DO NOTHING
RETURNING receipt_hash, workspace_id, decision, triggered_rules, reasons,
          policy_version, evaluated_at, created_at
`;

export async function insertDecisionTx(
  q: Queryable,
  receiptHash: string,
  workspaceId: string,
  decision: Decision,
): Promise<{ stored: StoredDecision; duplicate: boolean }> {
  const result = await q.query(INSERT_SQL, [
    receiptHash,
    workspaceId,
    decision.decision,
    JSON.stringify(decision.triggered_rules),
    JSON.stringify(decision.reasons),
    decision.policy_version,
    decision.evaluated_at,
  ]);

  if (result.rowCount && result.rowCount > 0) {
    const row = result.rows[0]!;
    return { stored: rowToStored(row), duplicate: false };
  }

  const existing = await findDecisionByReceiptHash(q, receiptHash);
  if (!existing) {
    throw new Error('decision insert conflict but row not found');
  }
  return { stored: existing, duplicate: true };
}

export async function findDecisionByReceiptHash(
  q: Queryable,
  receiptHash: string,
): Promise<StoredDecision | null> {
  const result = await q.query(
    `SELECT receipt_hash, workspace_id, decision, triggered_rules, reasons,
            policy_version, evaluated_at, created_at
     FROM decisions WHERE receipt_hash = $1`,
    [receiptHash],
  );
  if (result.rowCount === 0) return null;
  return rowToStored(result.rows[0]!);
}

function rowToStored(row: Record<string, unknown>): StoredDecision {
  return {
    receipt_hash: row.receipt_hash as string,
    workspace_id: row.workspace_id as string,
    decision: row.decision as StoredDecision['decision'],
    triggered_rules: row.triggered_rules as string[],
    reasons: row.reasons as string[],
    policy_version: row.policy_version as string,
    evaluated_at: row.evaluated_at as Date,
    created_at: row.created_at as Date,
  };
}

// ---------------------------------------------------------------------------
// Query layer: list decisions joined to their receipts so we can apply the
// shared receipt-side filters (agent_id, action_type, tool_id, chain_id,
// issuer) and use the receipt's `ts` as the cursor ordering key for
// consistency with /receipts.
// ---------------------------------------------------------------------------

export interface DecisionRow {
  stored: StoredDecision;
  receipt_ts: Date;
  receipt_id: string;
}

export interface ListDecisionsResult {
  rows: DecisionRow[];
  next_cursor: string | null;
}

export async function listDecisions(
  q: Queryable,
  workspaceId: string,
  filters: Filters,
  cursor: ParsedCursor | null,
  limit: number,
): Promise<ListDecisionsResult> {
  const bindings: unknown[] = [];
  const push = (v: unknown): string => {
    bindings.push(v);
    return `$${bindings.length}`;
  };

  const where: string[] = [`d.workspace_id = ${push(workspaceId)}`];

  if (filters.agent_id !== undefined) where.push(`r.agent_id = ${push(filters.agent_id)}`);
  if (filters.action_type !== undefined) where.push(`r.action_type = ${push(filters.action_type)}`);
  if (filters.tool_id !== undefined) {
    where.push(`r.action_context->'ors'->'commitments'->>'tool_id' = ${push(filters.tool_id)}`);
  }
  if (filters.chain_id !== undefined) {
    where.push(`r.action_context->'ors'->'chain'->>'chain_id' = ${push(filters.chain_id)}`);
  }
  if (filters.issuer !== undefined) where.push(`r.issuer = ${push(filters.issuer)}`);
  if (filters.from !== undefined) where.push(`r.ts >= ${push(filters.from)}`);
  if (filters.to !== undefined) where.push(`r.ts <= ${push(filters.to)}`);
  if (filters.decision !== undefined) where.push(`d.decision = ${push(filters.decision)}`);
  if (filters.triggered_rule !== undefined) {
    where.push(`d.triggered_rules ? ${push(filters.triggered_rule)}`);
  }
  if (filters.policy_version !== undefined) {
    where.push(`d.policy_version = ${push(filters.policy_version)}`);
  }
  if (filters.q !== undefined) {
    where.push(
      `EXISTS (SELECT 1 FROM jsonb_array_elements_text(d.reasons) reason WHERE reason ILIKE ${push('%' + filters.q + '%')})`,
    );
  }

  if (cursor) {
    const t = push(cursor.t);
    const i = push(cursor.i);
    where.push(`(r.ts, r.receipt_id) < (${t}, ${i})`);
  }

  const limitPlus1 = push(limit + 1);

  const sql = `
    SELECT d.receipt_hash, d.workspace_id, d.decision, d.triggered_rules, d.reasons,
           d.policy_version, d.evaluated_at, d.created_at,
           r.ts AS receipt_ts, r.receipt_id AS receipt_id
    FROM decisions d
    INNER JOIN receipts r ON r.canonical_hash = d.receipt_hash
    WHERE ${where.join(' AND ')}
    ORDER BY r.ts DESC, r.receipt_id DESC
    LIMIT ${limitPlus1}
  `;

  const result = await q.query(sql, bindings);
  const rows: DecisionRow[] = result.rows.map((row: Record<string, unknown>) => ({
    stored: rowToStored(row),
    receipt_ts: row.receipt_ts as Date,
    receipt_id: row.receipt_id as string,
  }));

  let next_cursor: string | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1]!;
    rows.splice(limit);
    next_cursor = encodeCursor({ t: last.receipt_ts.toISOString(), i: last.receipt_id });
  }

  return { rows, next_cursor };
}

export function storedDecisionToApi(d: StoredDecision): Decision {
  return {
    decision: d.decision,
    triggered_rules: d.triggered_rules,
    reasons: d.reasons,
    policy_version: d.policy_version,
    evaluated_at: d.evaluated_at.toISOString(),
  };
}
