// Query API tests — exercises GET /v1/receipts, GET /v1/receipts/{hash}, and
// GET /v1/decisions end-to-end through Fastify against a real Postgres.
//
// Strategy:
//   - Unit tests for parseReceiptQuery / parseDecisionQuery cover all filter
//     validation paths without touching the database.
//   - Integration tests (skipped unless TEST_DATABASE_URL is set) ingest a
//     small corpus through the real POST /v1/receipts/ingest route — same
//     code path users hit — so the join shapes, the LEFT/INNER promotion, and
//     the cursor pagination are all tested against the actual stored rows.
//
// SQL safety: every filter value reaches pg as a numbered placeholder. The
// `?aggregate=' OR 1=1 --` style payloads here exercise the parser path; the
// db helpers themselves never interpolate user input.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2';

import { canonicalHash, signingInput } from '@openterms/sdk';
import type { Jwks } from '@openterms/sdk';
import { registerReceiptRoutes } from '../src/routes/receipts.js';
import { registerReceiptQueryRoutes } from '../src/routes/receipts_query.js';
import { registerDecisionRoutes } from '../src/routes/decisions.js';
import { runMigrations } from '../src/db/migrate.js';
import { parseDecisionQuery, parseReceiptQuery } from '../src/routes/query_params.js';
import { decodeCursor, encodeCursor } from '../src/db/query_types.js';

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

let _idCounter = 0;
function nextReceiptUuid(): string {
  _idCounter += 1;
  const hex = _idCounter.toString(16).padStart(12, '0');
  return `11111111-1111-4111-8111-${hex}`;
}

function getKeyMaterial(): { seed: Uint8Array; pub: Uint8Array } {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) seed[i] = (i * 7 + 1) & 0xff;
  const pub = ed.getPublicKey(seed);
  return { seed, pub };
}

function makeSignedReceipt(overrides: Record<string, unknown> = {}): {
  receipt: Record<string, unknown>;
  jwks: Jwks;
} {
  const { seed, pub } = getKeyMaterial();
  const basePayload: Record<string, unknown> = {
    workspace_id: WORKSPACE_ID,
    agent_id: 'agent-it',
    action_type: 'api_call',
    terms_url: 'https://example.com/terms',
    terms_hash: 'a'.repeat(64),
    timestamp: '2026-05-20T00:00:00.000Z',
    pricing_version: 'v1',
    receipt_id: nextReceiptUuid(),
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

// ---------------------------------------------------------------------------
// Parser unit tests — no DB required.
// ---------------------------------------------------------------------------

describe('parseReceiptQuery', () => {
  it('returns defaults for an empty query string', () => {
    const r = parseReceiptQuery({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.limit).toBe(50);
      expect(r.value.aggregate).toBe('none');
      expect(r.value.cursor).toBeNull();
      expect(r.value.filters).toEqual({});
    }
  });

  it('rejects an unknown aggregate mode', () => {
    const r = parseReceiptQuery({ aggregate: 'count_by_userid' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('aggregate');
  });

  it('rejects an unknown action_type', () => {
    const r = parseReceiptQuery({ action_type: 'spaghetti' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('action_type');
  });

  it('rejects an unknown decision outcome', () => {
    const r = parseReceiptQuery({ decision: 'maybe' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('decision');
  });

  it('clamps limit out of range', () => {
    expect(parseReceiptQuery({ limit: '0' }).ok).toBe(false);
    expect(parseReceiptQuery({ limit: '201' }).ok).toBe(false);
    expect(parseReceiptQuery({ limit: 'abc' }).ok).toBe(false);
    expect(parseReceiptQuery({ limit: '50' }).ok).toBe(true);
  });

  it('parses from/to into ISO 8601 datetimes', () => {
    const r = parseReceiptQuery({ from: '2026-01-01T00:00:00Z', to: '2026-12-31T23:59:59Z' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.filters.from).toBe('2026-01-01T00:00:00.000Z');
      expect(r.value.filters.to).toBe('2026-12-31T23:59:59.000Z');
    }
  });

  it('does not accept policy_version (decisions-only filter)', () => {
    const r = parseReceiptQuery({ policy_version: 'v1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.filters.policy_version).toBeUndefined();
  });

  it('passes filter values through as-is so the db layer can bind them', () => {
    // The parser is intentionally permissive about the *content* of filter
    // strings (agent_id, tool_id, q, chain_id) — those values are bound to pg
    // placeholders, not interpolated. A SQLish payload here proves the parser
    // does not try to escape or reject it.
    const r = parseReceiptQuery({
      agent_id: "agent'; DROP TABLE receipts; --",
      tool_id: 'tools/run',
      q: "%' OR '1'='1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.filters.agent_id).toBe("agent'; DROP TABLE receipts; --");
      expect(r.value.filters.q).toBe("%' OR '1'='1");
    }
  });
});

describe('parseDecisionQuery', () => {
  it('accepts policy_version', () => {
    const r = parseDecisionQuery({ policy_version: 'session-test-policy-v1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.filters.policy_version).toBe('session-test-policy-v1');
  });
});

describe('cursor codec', () => {
  it('round-trips a (timestamp, receipt_id) tuple', () => {
    const c = { t: '2026-05-20T00:00:00.000Z', i: '11111111-1111-4111-8111-111111111111' };
    const encoded = encodeCursor(c);
    expect(decodeCursor(encoded)).toEqual(c);
  });

  it('returns null on garbage input', () => {
    expect(decodeCursor('not-base64!')).toBeNull();
    expect(decodeCursor(Buffer.from('{}').toString('base64'))).toBeNull();
    expect(decodeCursor(Buffer.from('{"t":"bad","i":"x"}').toString('base64'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration tests — full Fastify + Postgres roundtrip.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)('Query API integration', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let sharedJwks: Jwks;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    await runMigrations(TEST_DATABASE_URL);
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

    const { jwks } = makeSignedReceipt();
    sharedJwks = jwks;

    app = Fastify({ logger: false });
    const config = {
      databaseUrl: TEST_DATABASE_URL!,
      jwksSource: 'memory:test',
      workspaceId: WORKSPACE_ID,
      port: 0,
      logLevel: 'silent',
    };
    registerReceiptRoutes(app, { pool, config, loadJwks: async () => sharedJwks });
    registerReceiptQueryRoutes(app, { pool, config });
    registerDecisionRoutes(app, { pool, config });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE decisions, idempotency_keys, receipts RESTART IDENTITY CASCADE',
    );
  });

  async function ingest(overrides: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { receipt } = makeSignedReceipt(overrides);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/receipts/ingest',
      payload: receipt,
      headers: { 'content-type': 'application/json' },
    });
    if (res.statusCode !== 201 && res.statusCode !== 200) {
      throw new Error(`ingest failed (${res.statusCode}): ${res.body}`);
    }
    return receipt;
  }

  async function get(url: string) {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  describe('GET /v1/receipts — filters', () => {
    it('filters by agent_id', async () => {
      await ingest({ agent_id: 'alice', timestamp: '2026-05-20T01:00:00.000Z' });
      await ingest({ agent_id: 'bob', timestamp: '2026-05-20T02:00:00.000Z' });
      const body = await get('/v1/receipts?agent_id=alice');
      expect(body.receipts).toHaveLength(1);
      expect(body.receipts[0].receipt.agent_id).toBe('alice');
    });

    it('filters by action_type', async () => {
      await ingest({ action_type: 'api_call', timestamp: '2026-05-20T01:00:00.000Z' });
      await ingest({ action_type: 'data_access', timestamp: '2026-05-20T02:00:00.000Z' });
      const body = await get('/v1/receipts?action_type=data_access');
      expect(body.receipts).toHaveLength(1);
      expect(body.receipts[0].receipt.action_type).toBe('data_access');
    });

    it('filters by tool_id via action_context.ors.commitments', async () => {
      await ingest({
        timestamp: '2026-05-20T01:00:00.000Z',
        action_context: { ors: { commitments: { tool_id: 'tools/run' } } },
      });
      await ingest({
        timestamp: '2026-05-20T02:00:00.000Z',
        action_context: { ors: { commitments: { tool_id: 'tools/scan' } } },
      });
      const body = await get('/v1/receipts?tool_id=tools%2Fscan');
      expect(body.receipts).toHaveLength(1);
    });

    it('filters by chain_id via action_context.ors.chain', async () => {
      await ingest({
        timestamp: '2026-05-20T01:00:00.000Z',
        action_context: { ors: { chain: { chain_id: 'chain-a' } } },
      });
      await ingest({
        timestamp: '2026-05-20T02:00:00.000Z',
        action_context: { ors: { chain: { chain_id: 'chain-b' } } },
      });
      const body = await get('/v1/receipts?chain_id=chain-a');
      expect(body.receipts).toHaveLength(1);
      const ctx = body.receipts[0].receipt.action_context as Record<string, unknown>;
      expect((ctx.ors as Record<string, unknown>).chain).toEqual({ chain_id: 'chain-a' });
    });

    it('filters by issuer', async () => {
      await ingest({
        issuer: 'https://issuer-a.example.com',
        timestamp: '2026-05-20T01:00:00.000Z',
      });
      await ingest({
        issuer: 'https://issuer-b.example.com',
        timestamp: '2026-05-20T02:00:00.000Z',
      });
      const body = await get('/v1/receipts?issuer=https%3A%2F%2Fissuer-a.example.com');
      expect(body.receipts).toHaveLength(1);
    });

    it('filters by decision outcome (forces INNER JOIN against decisions)', async () => {
      await ingest({ amount_charged: 100, timestamp: '2026-05-20T01:00:00.000Z' });
      // Amount above MAX_AMOUNT_DEFAULT (10_000_000) → deny.
      await ingest({ amount_charged: 20_000_000, timestamp: '2026-05-20T02:00:00.000Z' });
      const allow = await get('/v1/receipts?decision=allow');
      expect(allow.receipts).toHaveLength(1);
      expect(allow.receipts[0].decision.decision).toBe('allow');
      const deny = await get('/v1/receipts?decision=deny');
      expect(deny.receipts).toHaveLength(1);
      expect(deny.receipts[0].decision.decision).toBe('deny');
    });

    it('filters by triggered_rule via the JSONB ? operator', async () => {
      await ingest({ amount_charged: 100, timestamp: '2026-05-20T01:00:00.000Z' });
      await ingest({ amount_charged: 20_000_000, timestamp: '2026-05-20T02:00:00.000Z' });
      const body = await get('/v1/receipts?triggered_rule=max_amount_default');
      expect(body.receipts).toHaveLength(1);
      expect(body.receipts[0].decision.triggered_rules).toContain('max_amount_default');
    });

    it('filters by from/to timestamp range (inclusive)', async () => {
      await ingest({ timestamp: '2026-05-20T01:00:00.000Z' });
      await ingest({ timestamp: '2026-05-20T05:00:00.000Z' });
      await ingest({ timestamp: '2026-05-20T09:00:00.000Z' });
      const body = await get('/v1/receipts?from=2026-05-20T02:00:00Z&to=2026-05-20T06:00:00Z');
      expect(body.receipts).toHaveLength(1);
      expect(body.receipts[0].receipt.timestamp).toBe('2026-05-20T05:00:00.000Z');
    });

    it('filters by q (substring search on decision reasons)', async () => {
      await ingest({ amount_charged: 100, timestamp: '2026-05-20T01:00:00.000Z' });
      await ingest({ amount_charged: 20_000_000, timestamp: '2026-05-20T02:00:00.000Z' });
      // The deny decision's reasons include "MAX_AMOUNT" — case-insensitive
      // substring search matches a lowercase needle.
      const body = await get('/v1/receipts?q=max_amount');
      expect(body.receipts).toHaveLength(1);
      expect(body.receipts[0].decision.decision).toBe('deny');
    });
  });

  describe('GET /v1/receipts — aggregations', () => {
    it('aggregates by decision', async () => {
      await ingest({ amount_charged: 100, timestamp: '2026-05-20T01:00:00.000Z' });
      await ingest({ amount_charged: 200, timestamp: '2026-05-20T02:00:00.000Z' });
      await ingest({ amount_charged: 20_000_000, timestamp: '2026-05-20T03:00:00.000Z' });
      const body = await get('/v1/receipts?aggregate=count_by_decision');
      expect(body.dimension).toBe('decision');
      const map = Object.fromEntries(
        (body.buckets as { key: string; count: number }[]).map((b) => [b.key, b.count]),
      );
      expect(map).toEqual({ allow: 2, deny: 1 });
    });

    it('aggregates by rule (unnests triggered_rules)', async () => {
      await ingest({ amount_charged: 100, timestamp: '2026-05-20T01:00:00.000Z' });
      await ingest({ amount_charged: 20_000_000, timestamp: '2026-05-20T02:00:00.000Z' });
      await ingest({ amount_charged: 30_000_000, timestamp: '2026-05-20T03:00:00.000Z' });
      const body = await get('/v1/receipts?aggregate=count_by_rule');
      expect(body.dimension).toBe('rule');
      expect(body.buckets).toEqual([{ key: 'max_amount_default', count: 2 }]);
    });

    it('aggregates by tool', async () => {
      await ingest({
        timestamp: '2026-05-20T01:00:00.000Z',
        action_context: { ors: { commitments: { tool_id: 'tools/a' } } },
      });
      await ingest({
        timestamp: '2026-05-20T02:00:00.000Z',
        action_context: { ors: { commitments: { tool_id: 'tools/a' } } },
      });
      await ingest({
        timestamp: '2026-05-20T03:00:00.000Z',
        action_context: { ors: { commitments: { tool_id: 'tools/b' } } },
      });
      await ingest({ timestamp: '2026-05-20T04:00:00.000Z' }); // no commitments → excluded
      const body = await get('/v1/receipts?aggregate=count_by_tool');
      expect(body.dimension).toBe('tool');
      const map = Object.fromEntries(
        (body.buckets as { key: string; count: number }[]).map((b) => [b.key, b.count]),
      );
      expect(map).toEqual({ 'tools/a': 2, 'tools/b': 1 });
    });

    it('aggregates by agent', async () => {
      await ingest({ agent_id: 'a1', timestamp: '2026-05-20T01:00:00.000Z' });
      await ingest({ agent_id: 'a1', timestamp: '2026-05-20T02:00:00.000Z' });
      await ingest({ agent_id: 'a2', timestamp: '2026-05-20T03:00:00.000Z' });
      const body = await get('/v1/receipts?aggregate=count_by_agent');
      expect(body.dimension).toBe('agent');
      const map = Object.fromEntries(
        (body.buckets as { key: string; count: number }[]).map((b) => [b.key, b.count]),
      );
      expect(map).toEqual({ a1: 2, a2: 1 });
    });

    it('aggregates by hour with UTC keys', async () => {
      await ingest({ timestamp: '2026-05-20T01:15:00.000Z' });
      await ingest({ timestamp: '2026-05-20T01:45:00.000Z' });
      await ingest({ timestamp: '2026-05-20T02:30:00.000Z' });
      const body = await get('/v1/receipts?aggregate=count_by_hour');
      expect(body.dimension).toBe('hour');
      expect(body.buckets).toEqual([
        { key: '2026-05-20T01:00:00Z', count: 2 },
        { key: '2026-05-20T02:00:00Z', count: 1 },
      ]);
    });

    it('aggregates by day with UTC keys', async () => {
      await ingest({ timestamp: '2026-05-20T01:00:00.000Z' });
      await ingest({ timestamp: '2026-05-20T23:00:00.000Z' });
      await ingest({ timestamp: '2026-05-21T00:30:00.000Z' });
      const body = await get('/v1/receipts?aggregate=count_by_day');
      expect(body.dimension).toBe('day');
      expect(body.buckets).toEqual([
        { key: '2026-05-20', count: 2 },
        { key: '2026-05-21', count: 1 },
      ]);
    });
  });

  describe('GET /v1/receipts — cursor pagination', () => {
    it('pages stably through results in reverse-chronological order', async () => {
      const seen: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const ts = `2026-05-20T0${i}:00:00.000Z`;
        const r = await ingest({ timestamp: ts });
        seen.push(r.canonical_hash as string);
      }
      // We saw them in ts-ascending order; pagination is ts DESC.
      const expectedOrder = [...seen].reverse();

      const collected: string[] = [];
      let cursor: string | null = null;
      // Three pages of size 3 cover seven results.
      for (let page = 0; page < 4; page += 1) {
        const url = cursor
          ? `/v1/receipts?limit=3&cursor=${encodeURIComponent(cursor)}`
          : '/v1/receipts?limit=3';
        const body = await get(url);
        for (const r of body.receipts) collected.push(r.hash);
        cursor = body.next_cursor;
        if (cursor === null) break;
      }
      expect(cursor).toBeNull();
      expect(collected).toEqual(expectedOrder);
    });

    it('is stable against concurrent inserts at higher timestamps', async () => {
      // Insert three receipts. Page 1 returns the latest two; before page 2,
      // insert another at a *higher* timestamp. Page 2 must still return the
      // original first receipt — the new insert does not appear and does not
      // bump anything off page 2.
      const r1 = await ingest({ timestamp: '2026-05-20T01:00:00.000Z' });
      const r2 = await ingest({ timestamp: '2026-05-20T02:00:00.000Z' });
      const r3 = await ingest({ timestamp: '2026-05-20T03:00:00.000Z' });

      const page1 = await get('/v1/receipts?limit=2');
      expect(page1.receipts.map((r: { hash: string }) => r.hash)).toEqual([
        r3.canonical_hash,
        r2.canonical_hash,
      ]);
      expect(page1.next_cursor).not.toBeNull();

      // Concurrent insert at a higher timestamp than anything we've paged.
      await ingest({ timestamp: '2026-05-20T09:00:00.000Z' });

      const page2 = await get(
        `/v1/receipts?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`,
      );
      expect(page2.receipts.map((r: { hash: string }) => r.hash)).toEqual([r1.canonical_hash]);
      expect(page2.next_cursor).toBeNull();
    });
  });

  describe('GET /v1/receipts/{hash}', () => {
    it('returns a single receipt with its decision', async () => {
      const r = await ingest({ timestamp: '2026-05-20T01:00:00.000Z' });
      const body = await get(`/v1/receipts/${r.canonical_hash as string}`);
      expect(body.hash).toBe(r.canonical_hash);
      expect(body.decision).not.toBeNull();
      expect(body.decision.decision).toBe('allow');
    });

    it('returns 404 for unknown hashes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/receipts/' + 'f'.repeat(64),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });

    it('returns 400 for malformed hash', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/receipts/not-a-hash' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /v1/decisions', () => {
    it('lists decisions with their receipt_hash', async () => {
      const r = await ingest({ timestamp: '2026-05-20T01:00:00.000Z' });
      const body = await get('/v1/decisions');
      expect(body.decisions).toHaveLength(1);
      expect(body.decisions[0].receipt_hash).toBe(r.canonical_hash);
      expect(body.decisions[0].decision).toBe('allow');
      expect(body.decisions[0].policy_version).toBe('session-test-policy-v1');
    });

    it('filters by policy_version', async () => {
      await ingest({ timestamp: '2026-05-20T01:00:00.000Z' });
      const present = await get('/v1/decisions?policy_version=session-test-policy-v1');
      expect(present.decisions).toHaveLength(1);
      const absent = await get('/v1/decisions?policy_version=session-test-policy-v999');
      expect(absent.decisions).toHaveLength(0);
    });

    it('filters by triggered_rule', async () => {
      await ingest({ amount_charged: 100, timestamp: '2026-05-20T01:00:00.000Z' });
      await ingest({ amount_charged: 20_000_000, timestamp: '2026-05-20T02:00:00.000Z' });
      const body = await get('/v1/decisions?triggered_rule=max_amount_default');
      expect(body.decisions).toHaveLength(1);
      expect(body.decisions[0].decision).toBe('deny');
    });

    it('pages with stable cursors', async () => {
      for (let i = 0; i < 5; i += 1) {
        await ingest({ timestamp: `2026-05-20T0${i}:00:00.000Z` });
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 4; page += 1) {
        const url = cursor
          ? `/v1/decisions?limit=2&cursor=${encodeURIComponent(cursor)}`
          : '/v1/decisions?limit=2';
        const body = await get(url);
        for (const d of body.decisions) seen.push(d.receipt_hash);
        cursor = body.next_cursor;
        if (cursor === null) break;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });
  });

  describe('end-to-end integration', () => {
    it('ingests a mixed corpus and queries it back through filters and aggregates', async () => {
      // Three agents × two action types × varying amounts. Some trigger deny.
      const fixtures = [
        { agent_id: 'alice', action_type: 'api_call', amount_charged: 100 },
        { agent_id: 'alice', action_type: 'api_call', amount_charged: 20_000_000 }, // deny
        { agent_id: 'alice', action_type: 'data_access', amount_charged: 200 },
        { agent_id: 'bob', action_type: 'api_call', amount_charged: 300 },
        { agent_id: 'bob', action_type: 'data_access', amount_charged: 30_000_000 }, // deny
        { agent_id: 'carol', action_type: 'api_call', amount_charged: 400 },
      ];
      let hourOffset = 0;
      for (const f of fixtures) {
        hourOffset += 1;
        await ingest({ ...f, timestamp: `2026-05-20T0${hourOffset}:00:00.000Z` });
      }

      const aliceOnly = await get('/v1/receipts?agent_id=alice');
      expect(aliceOnly.receipts).toHaveLength(3);

      const dataAccess = await get('/v1/receipts?action_type=data_access');
      expect(dataAccess.receipts).toHaveLength(2);

      const denies = await get('/v1/receipts?decision=deny');
      expect(denies.receipts).toHaveLength(2);

      const byAgent = await get('/v1/receipts?aggregate=count_by_agent');
      const agentMap = Object.fromEntries(
        (byAgent.buckets as { key: string; count: number }[]).map((b) => [b.key, b.count]),
      );
      expect(agentMap).toEqual({ alice: 3, bob: 2, carol: 1 });

      const byDecision = await get('/v1/receipts?aggregate=count_by_decision');
      const decisionMap = Object.fromEntries(
        (byDecision.buckets as { key: string; count: number }[]).map((b) => [b.key, b.count]),
      );
      expect(decisionMap).toEqual({ allow: 4, deny: 2 });

      // /v1/decisions sees the same six rows.
      const decisions = await get('/v1/decisions?limit=200');
      expect(decisions.decisions).toHaveLength(6);
    });
  });
});

describe.skipIf(HAS_DB)('query integration tests skipped (no TEST_DATABASE_URL)', () => {
  it('placeholder so the file always reports at least one result', () => {
    expect(true).toBe(true);
  });
});
