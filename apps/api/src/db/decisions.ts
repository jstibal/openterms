import type { Pool, PoolClient } from 'pg';

import type { Decision } from '../core/policy_types.js';

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

export function storedDecisionToApi(d: StoredDecision): Decision {
  return {
    decision: d.decision,
    triggered_rules: d.triggered_rules,
    reasons: d.reasons,
    policy_version: d.policy_version,
    evaluated_at: d.evaluated_at.toISOString(),
  };
}
