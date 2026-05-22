// Corpus tests — load the fixture corpus at tests/fixtures/corpus/ through
// the real ingest + query pipeline. Verifies that the on-the-wire receipts
// the Python generator produces are accepted by the TypeScript API and that
// the query surface returns sensible aggregates over a realistic dataset.
//
// These tests skip when TEST_DATABASE_URL is unset, matching query.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2';

import type { Jwks } from '@openterms-ai/sdk';
import { registerReceiptRoutes } from '../src/routes/receipts.js';
import { registerReceiptQueryRoutes } from '../src/routes/receipts_query.js';
import { registerDecisionRoutes } from '../src/routes/decisions.js';
import { runMigrations } from '../src/db/migrate.js';
import { testConfig } from './_helpers/config.js';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const HAS_DB = !!TEST_DATABASE_URL;

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = resolve(HERE, '../../../tests/fixtures/corpus');

interface CorpusReceipt extends Record<string, unknown> {
  workspace_id: string;
  receipt_id: string;
  canonical_hash: string;
  amount_charged: number;
  action_type: string;
  agent_id: string;
}

interface CorpusDecision {
  receipt_hash: string;
  decision: 'allow' | 'deny' | 'escalate';
  triggered_rules: string[];
  reasons: string[];
  policy_version: string;
  evaluated_at: string;
}

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(CORPUS_DIR, name), 'utf8')) as T;
}

const RECEIPTS = loadJson<CorpusReceipt[]>('receipts.json');
const DECISIONS = loadJson<CorpusDecision[]>('decisions.json');
const JWKS = loadJson<Jwks>('jwks.json');

const WORKSPACE_ID = RECEIPTS[0].workspace_id;

// Sanity-check that the corpus is well-formed on load — these run regardless
// of TEST_DATABASE_URL so the corpus shape is exercised in unit-only CI too.
describe('corpus (offline shape)', () => {
  it('loads 500 receipts paired with 500 decisions', () => {
    expect(RECEIPTS).toHaveLength(500);
    expect(DECISIONS).toHaveLength(500);
  });

  it('every decision references an existing receipt canonical_hash', () => {
    const hashes = new Set(RECEIPTS.map((r) => r.canonical_hash));
    for (const d of DECISIONS) {
      expect(hashes.has(d.receipt_hash)).toBe(true);
    }
  });

  it('jwks contains the two corpus kids', () => {
    const kids = (JWKS.keys ?? []).map((k) => (k as { kid: string }).kid);
    expect(kids.sort()).toEqual(['ot-corpus-2025z', 'ot-corpus-2026a']);
  });

  it('all five ORS action types appear', () => {
    const types = new Set(RECEIPTS.map((r) => r.action_type));
    expect(types).toEqual(
      new Set(['api_call', 'data_access', 'purchase', 'custom', 'model_training']),
    );
  });
});

describe.skipIf(!HAS_DB)('corpus ingest + query integration', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    await runMigrations(TEST_DATABASE_URL!);
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

    app = Fastify({ logger: false });
    const config = testConfig({
      databaseUrl: TEST_DATABASE_URL!,
      workspaceId: WORKSPACE_ID,
    });
    registerReceiptRoutes(app, { pool, config, loadJwks: async () => JWKS });
    registerReceiptQueryRoutes(app, { pool, config });
    registerDecisionRoutes(app, { pool, config });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE decisions, idempotency_keys, receipts RESTART IDENTITY CASCADE',
    );
  });

  async function ingestAll(): Promise<void> {
    for (const receipt of RECEIPTS) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/receipts/ingest',
        payload: receipt,
        headers: { 'content-type': 'application/json' },
      });
      if (res.statusCode !== 201 && res.statusCode !== 200) {
        throw new Error(`ingest failed for ${receipt.receipt_id} (${res.statusCode}): ${res.body}`);
      }
    }
  }

  async function get(url: string) {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('ingests every corpus receipt successfully', async () => {
    await ingestAll();
    const body = await get('/v1/receipts?limit=200');
    expect(body.receipts).toHaveLength(200);
    // Cursor pagination wraps the rest.
    expect(body.next_cursor).toBeTypeOf('string');
  }, 60_000);

  it('paginates the full corpus across 3 pages', async () => {
    await ingestAll();
    let cursor: string | null = null;
    let seen = 0;
    for (let page = 0; page < 4; page += 1) {
      const url = `/v1/receipts?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = await get(url);
      seen += body.receipts.length;
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toBe(500);
    expect(cursor).toBeNull();
  }, 60_000);

  it('filters by agent_id (known agent in scenario)', async () => {
    await ingestAll();
    const expected = RECEIPTS.filter((r) => r.agent_id === 'acme-research-bot').length;
    expect(expected).toBeGreaterThan(0);
    const body = await get('/v1/receipts?agent_id=acme-research-bot&limit=200');
    // Pagination may chunk; collect across pages.
    let total = body.receipts.length;
    let cursor: string | null = body.next_cursor;
    while (cursor) {
      const next = await get(
        `/v1/receipts?agent_id=acme-research-bot&limit=200&cursor=${encodeURIComponent(cursor)}`,
      );
      total += next.receipts.length;
      cursor = next.next_cursor;
    }
    expect(total).toBe(expected);
  }, 60_000);

  it('filters by action_type=model_training', async () => {
    await ingestAll();
    const expected = RECEIPTS.filter((r) => r.action_type === 'model_training').length;
    expect(expected).toBeGreaterThan(0);
    const body = await get('/v1/receipts?action_type=model_training&limit=200');
    expect(body.receipts).toHaveLength(expected);
  }, 60_000);

  it('aggregates by agent and matches the corpus distribution', async () => {
    await ingestAll();
    const body = await get('/v1/receipts?aggregate=count_by_agent');
    const map = Object.fromEntries(
      (body.buckets as { key: string; count: number }[]).map((b) => [b.key, b.count]),
    );
    const counted: Record<string, number> = {};
    for (const r of RECEIPTS) {
      counted[r.agent_id] = (counted[r.agent_id] ?? 0) + 1;
    }
    expect(map).toEqual(counted);
  }, 60_000);

  it('aggregates by tool and matches the corpus distribution for receipts with tool_id', async () => {
    await ingestAll();
    const body = await get('/v1/receipts?aggregate=count_by_tool');
    const map = Object.fromEntries(
      (body.buckets as { key: string; count: number }[]).map((b) => [b.key, b.count]),
    );
    const counted: Record<string, number> = {};
    for (const r of RECEIPTS) {
      const ctx = r['action_context'] as
        | { ors?: { commitments?: { tool_id?: string } } }
        | undefined;
      const tid = ctx?.ors?.commitments?.tool_id;
      if (tid) counted[tid] = (counted[tid] ?? 0) + 1;
    }
    expect(map).toEqual(counted);
  }, 60_000);
});

describe.skipIf(HAS_DB)('corpus integration tests skipped (no TEST_DATABASE_URL)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
});
