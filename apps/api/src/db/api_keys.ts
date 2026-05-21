import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { Pool } from 'pg';

export type KeyEnv = 'live' | 'test';

const PREFIX_LIVE = 'ot_live_';
const PREFIX_TEST = 'ot_test_';

export interface ApiKeyRow {
  id: string;
  workspaceId: string;
  keyPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

// Token format: ot_{env}_<base32url 32 bytes>. Base32url avoids the '+' / '/'
// characters that show up in base64 and that some HTTP middlewares mishandle
// in Authorization headers. The 32-byte payload is 256 bits of entropy.
export function generateApiKey(env: KeyEnv = 'live'): string {
  const prefix = env === 'live' ? PREFIX_LIVE : PREFIX_TEST;
  const buf = randomBytes(32);
  return `${prefix}${base32url(buf)}`;
}

export function parseTokenPrefix(token: string): KeyEnv | null {
  if (token.startsWith(PREFIX_LIVE)) return 'live';
  if (token.startsWith(PREFIX_TEST)) return 'test';
  return null;
}

// HMAC the full token under the server-side pepper. We use a constant-time
// HMAC so a leaked database (with key_hash rows) does not let an attacker
// recover the plaintext token even if they can brute-force token candidates,
// unless they also exfiltrate API_KEY_SALT from the running service.
export function hashApiKey(token: string, salt: string): Buffer {
  if (!salt) throw new Error('API_KEY_SALT is required to hash API keys');
  return createHmac('sha256', salt).update(token).digest();
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function lookupApiKey(
  pool: Pool,
  token: string,
  salt: string,
): Promise<ApiKeyRow | null> {
  const env = parseTokenPrefix(token);
  if (!env) return null;
  const hash = hashApiKey(token, salt);
  const result = await pool.query(
    `SELECT id, workspace_id, key_prefix, created_at, last_used_at, revoked_at
       FROM api_keys
      WHERE key_hash = $1
      LIMIT 1`,
    [hash],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

// Best-effort. A failed write here must not block the request — the caller
// catches and logs.
export async function touchLastUsed(pool: Pool, apiKeyId: string): Promise<void> {
  await pool.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [apiKeyId]);
}

export interface CreateApiKeyArgs {
  workspaceId: string;
  env?: KeyEnv;
  token?: string;
}

export interface CreateApiKeyResult {
  id: string;
  token: string;
  prefix: string;
}

export async function ensureWorkspace(
  pool: Pool,
  id: string,
  name: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO workspaces (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
    [id, name],
  );
}

export async function createApiKey(
  pool: Pool,
  salt: string,
  args: CreateApiKeyArgs,
): Promise<CreateApiKeyResult> {
  const env = args.env ?? 'live';
  const token = args.token ?? generateApiKey(env);
  const prefixLen = (env === 'live' ? PREFIX_LIVE : PREFIX_TEST).length + 6;
  const prefix = token.slice(0, prefixLen);
  const id = randomUUID();
  const hash = hashApiKey(token, salt);
  await pool.query(
    `INSERT INTO api_keys (id, workspace_id, key_prefix, key_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key_hash) DO NOTHING`,
    [id, args.workspaceId, prefix, hash],
  );
  return { id, token, prefix };
}

// Minimal RFC 4648 base32 (no padding, lowercase) — keeps tokens URL-safe.
function base32url(buf: Buffer): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 0x1f];
  }
  return out;
}
