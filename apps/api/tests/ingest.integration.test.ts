// Service-side ingest integration test. Boots the Fastify app against a real
// Postgres instance (TEST_DATABASE_URL), runs migrations including
// 003_create_decisions.sql, and asserts the three scenarios that matter for
// the policy-engine wiring:
//
//   1. Happy path — receipt under the active policy's allowlist and below the
//      max_amount threshold lands an `allow` decision row with empty
//      triggered_rules.
//   2. Deny path — receipt with amount_charged above the threshold lands a
//      `deny` decision row that records the triggered rule, AND the receipt
//      is still stored (per the proposal's agreed semantic).
//   3. Replay — re-posting the same payload returns 200 duplicate and the
//      decision row count remains 1 (decisions are immutable per receipt).
//
// Skipped unless TEST_DATABASE_URL is set so CI environments without
// Postgres still pass the rest of the suite. Companion to the Python e2e
// test under tests/integration/test_ingest_e2e.py — that test exercises
// cross-language compatibility from an SDK signer; this test exercises the
// in-process decision integration.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2';

import { canonicalHash, signingInput } from '@openterms/sdk';
import type { Jwks } from '@openterms/sdk';
import { registerReceiptRoutes } from '../src/routes/receipts.js';
import { runMigrations } from '../src/db/migrate.js';
import { MAX_AMOUNT_DEFAULT } from '../src/config.js';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const HAS_DB = !!TEST_DATABASE_URL;

const WORKSPACE_ID = '00000000-0000-4000-8000-0000000000aa';
const KEY_ID = 'integration-test-key';

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function makeSignedReceipt(overrides: Record<string, unknown> = {}): {
  receipt: Record<string, unknown>;
  jwks: Jwks;
} {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) seed[i] = (i * 7 + 1) & 0xff;
  const pub = ed.getPublicKey(seed);

  const basePayload: Record<string, unknown> = {
    workspace_id: WORKSPACE_ID,
    agent_id: 'agent-it',
    action_type: 'api_call',
    terms_url: 'https://example.com/terms',
    terms_hash: 'a'.repeat(64),
    timestamp: '2026-05-20T00:00:00.000Z',
    pricing_version: 'v1',
    receipt_id: '11111111-1111-4111-8111-1111111111aa',
    amount_charged: 250,
    created_at: '2026-05-20T00:00:00.001Z',
    ...overrides,
  };

  const hash = canonicalHash(basePayload);
  const sig = ed.sign(signingInput(basePayload), seed);
  const receipt = {
    ...basePayload,
    canonical_hash: hash,
    signature: b64url(sig),
    key_id: KEY_ID,
  };
  const jwks: Jwks = {
    keys: [{ kty: 'OKP', crv: 'Ed25519', kid: KEY_ID, x: b64url(pub), use: 'sig' }],
  };
  return { receipt, jwks };
}

describe.skipIf(!HAS_DB)('POST /v1/receipts/ingest — decision integration', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let sharedJwks: Jwks;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    await runMigrations(TEST_DATABASE_URL);
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

    // Build the JWKS once from the same seed used by makeSignedReceipt so the
    // service can verify signatures produced in the tests.
    const { jwks } = makeSignedReceipt();
    sharedJwks = jwks;

    app = Fastify({ logger: false });
    registerReceiptRoutes(app, {
      pool,
      config: {
        databaseUrl: TEST_DATABASE_URL!,
        jwksSource: 'memory:test',
        workspaceId: WORKSPACE_ID,
        port: 0,
        logLevel: 'silent',
      },
      loadJwks: async () => sharedJwks,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    // Order matters: idempotency_keys references receipts; decisions
    // references receipts. CASCADE handles it but explicit ordering is clearer.
    await pool.query(
      'TRUNCATE TABLE decisions, idempotency_keys, receipts RESTART IDENTITY CASCADE',
    );
  });

  it('stores an allow decision for a receipt under policy thresholds', async () => {
    const { receipt } = makeSignedReceipt({ amount_charged: 250 });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/receipts/ingest',
      payload: receipt,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.duplicate).toBe(false);
    expect(body.decision).toBeDefined();
    expect(body.decision.decision).toBe('allow');
    expect(body.decision.triggered_rules).toEqual([]);
    expect(body.decision.policy_version).toBe('session-test-policy-v1');

    const rows = await pool.query(
      'SELECT decision, triggered_rules FROM decisions WHERE receipt_hash = $1',
      [receipt.canonical_hash],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].decision).toBe('allow');
    expect(rows.rows[0].triggered_rules).toEqual([]);
  });

  it('stores a deny decision but still persists the receipt when amount exceeds threshold', async () => {
    const { receipt } = makeSignedReceipt({
      amount_charged: MAX_AMOUNT_DEFAULT + 1,
      receipt_id: '11111111-1111-4111-8111-1111111111bb',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/receipts/ingest',
      payload: receipt,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.decision.decision).toBe('deny');
    expect(body.decision.triggered_rules).toContain('max_amount_default');

    // Receipt is still stored despite the deny decision — the receipt is the
    // signed evidence of the action; the decision is an audit record of the
    // engine's ruling on that action.
    const receiptRows = await pool.query(
      'SELECT canonical_hash FROM receipts WHERE canonical_hash = $1',
      [receipt.canonical_hash],
    );
    expect(receiptRows.rowCount).toBe(1);

    const decisionRows = await pool.query(
      'SELECT decision FROM decisions WHERE receipt_hash = $1',
      [receipt.canonical_hash],
    );
    expect(decisionRows.rowCount).toBe(1);
    expect(decisionRows.rows[0].decision).toBe('deny');
  });

  it('returns 200 + decision on replay without re-evaluating', async () => {
    const { receipt } = makeSignedReceipt({
      amount_charged: 333,
      receipt_id: '11111111-1111-4111-8111-1111111111cc',
    });
    const first = await app.inject({
      method: 'POST',
      url: '/v1/receipts/ingest',
      payload: receipt,
      headers: { 'content-type': 'application/json' },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/receipts/ingest',
      payload: receipt,
      headers: { 'content-type': 'application/json' },
    });
    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.duplicate).toBe(true);
    expect(body.decision).toBeDefined();
    expect(body.decision.decision).toBe('allow');

    // The append-only trigger and the ON CONFLICT DO NOTHING contract together
    // guarantee a single decision row per receipt across any number of replays.
    const decisionRows = await pool.query(
      'SELECT COUNT(*)::int AS n FROM decisions WHERE receipt_hash = $1',
      [receipt.canonical_hash],
    );
    expect(decisionRows.rows[0].n).toBe(1);
  });

  it('replays the same canonical hash without an Idempotency-Key (duplicate path)', async () => {
    // Covers the path where a client retries the exact same payload without
    // sending Idempotency-Key. The service must still detect the duplicate by
    // canonical_hash (via the ON CONFLICT on the receipts PK), return 200
    // with duplicate=true, surface the prior decision, and never produce a
    // second decision row.
    const { receipt } = makeSignedReceipt({
      amount_charged: 444,
      receipt_id: '11111111-1111-4111-8111-1111111111dd',
    });
    const first = await app.inject({
      method: 'POST',
      url: '/v1/receipts/ingest',
      payload: receipt,
      headers: { 'content-type': 'application/json' },
    });
    expect(first.statusCode).toBe(201);

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/receipts/ingest',
      payload: receipt,
      headers: { 'content-type': 'application/json' }, // no Idempotency-Key
    });
    expect(replay.statusCode).toBe(200);
    const body = replay.json();
    expect(body.duplicate).toBe(true);
    expect(body.hash).toBe(receipt.canonical_hash);
    expect(body.decision).toBeDefined();

    const decisionRows = await pool.query(
      'SELECT COUNT(*)::int AS n FROM decisions WHERE receipt_hash = $1',
      [receipt.canonical_hash],
    );
    expect(decisionRows.rows[0].n).toBe(1);

    const receiptRows = await pool.query(
      'SELECT COUNT(*)::int AS n FROM receipts WHERE canonical_hash = $1',
      [receipt.canonical_hash],
    );
    expect(receiptRows.rows[0].n).toBe(1);
  });
});

describe.skipIf(HAS_DB)('integration tests skipped (no TEST_DATABASE_URL)', () => {
  it('placeholder so the file always reports at least one result', () => {
    expect(true).toBe(true);
  });
});
