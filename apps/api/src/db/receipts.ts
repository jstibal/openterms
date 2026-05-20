import type { Pool } from 'pg';

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
  pool: Pool,
  receipt: Record<string, unknown>,
): Promise<{ stored: StoredReceipt; duplicate: boolean }> {
  const r = rowFromReceipt(receipt);
  const result = await pool.query(INSERT_SQL, [
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

  const existing = await findByCanonicalHash(pool, r.canonical_hash);
  if (!existing) throw new Error('insert conflict but row not found');
  return { stored: existing, duplicate: true };
}

export async function findByCanonicalHash(
  pool: Pool,
  canonicalHash: string,
): Promise<StoredReceipt | null> {
  const result = await pool.query(
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

export async function recordIdempotencyKey(
  pool: Pool,
  workspaceId: string,
  key: string,
  canonicalHash: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO idempotency_keys (workspace_id, idempotency_key, canonical_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [workspaceId, key, canonicalHash],
  );
}

export async function lookupIdempotencyKey(
  pool: Pool,
  workspaceId: string,
  key: string,
): Promise<string | null> {
  const result = await pool.query(
    'SELECT canonical_hash FROM idempotency_keys WHERE workspace_id = $1 AND idempotency_key = $2',
    [workspaceId, key],
  );
  if (result.rowCount === 0) return null;
  return result.rows[0]!.canonical_hash as string;
}
