// Simulation integration test against the fixture corpus.
//
// Strategy:
//   1. Ingest the 500 corpus receipts through the live HTTP pipeline. The
//      ingest path writes a decision per receipt under the API's hardcoded
//      session-test-policy-v1, which is NOT what the simulation oracle
//      (simulation_expected_diffs.json) compares against.
//   2. Seed the decisions table with the policy_v1 decisions from
//      decisions.json — see seedDecisionsFromCorpus below.
//   3. POST /v1/simulate with policy_v2 (as a PolicyInput object) over the
//      full corpus time window.
//   4. Assert: total_diffs equals the 26 outcome-differing entries in the
//      oracle, the per-receipt (actual, counterfactual) decisions in the
//      sample match those entries, sample is deterministic across re-runs.
//
// The test skips when TEST_DATABASE_URL is unset, matching the rest of the
// integration suite.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2';

import type { Jwks } from '@openterms/sdk';
import { registerReceiptRoutes } from '../src/routes/receipts.js';
import { registerSimulateRoutes } from '../src/routes/simulate.js';
import { runMigrations } from '../src/db/migrate.js';

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
  created_at: string;
  timestamp: string;
}

interface CorpusDecision {
  receipt_hash: string;
  decision: 'allow' | 'deny' | 'escalate';
  triggered_rules: string[];
  reasons: string[];
  policy_version: string;
  evaluated_at: string;
}

interface SimulationOracleEntry {
  receipt_hash: string;
  v1: { decision: 'allow' | 'deny' | 'escalate'; triggered_rules: string[] };
  v2: { decision: 'allow' | 'deny' | 'escalate'; triggered_rules: string[] };
}

interface CorpusPolicyInput extends Record<string, unknown> {
  version: string;
  rules: Array<{
    id: string;
    type: string;
    outcome: 'allow' | 'deny' | 'escalate';
    parameters: Record<string, unknown>;
  }>;
}

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(CORPUS_DIR, name), 'utf8')) as T;
}

const RECEIPTS = loadJson<CorpusReceipt[]>('receipts.json');
const DECISIONS = loadJson<CorpusDecision[]>('decisions.json');
const ORACLE = loadJson<SimulationOracleEntry[]>('simulation_expected_diffs.json');
const POLICY_V2 = loadJson<CorpusPolicyInput>('policy_v2.json');
const JWKS = loadJson<Jwks>('jwks.json');

const WORKSPACE_ID = RECEIPTS[0].workspace_id;

// Outcome-only subset of the oracle. The 50 entries in
// simulation_expected_diffs.json include both decision-outcome changes (26)
// and same-outcome-different-rules changes (24). The API's SimulationResult
// schema describes diffs as "counterfactual differs from actual decision",
// so we filter to outcome diffs for the total_diffs and sample assertions.
const OUTCOME_ORACLE = ORACLE.filter((o) => o.v1.decision !== o.v2.decision);

/**
 * seedDecisionsFromCorpus — Test-only helper. DELIBERATELY bypasses the
 * policy engine and the ingest path's evaluate-and-store flow.
 *
 * The fixture corpus's decisions.json was computed under policy_v1 by the
 * Python generator. When the same receipts are ingested through apps/api,
 * the API writes decisions under the hardcoded session-test-policy-v1
 * (see apps/api/src/config.ts), which is a different policy with a
 * different rule set and threshold. The simulation oracle
 * (simulation_expected_diffs.json) compares policy_v1 vs policy_v2, so for
 * the integration assertion to be meaningful we must replace the API's
 * stored decisions with the corpus's policy_v1 decisions before running
 * /v1/simulate.
 *
 * The decisions table has UPDATE/DELETE triggers that reject mutation; we
 * TRUNCATE first (which the migration explicitly leaves available for test
 * setup) and re-insert. This is not a hack around the trigger contract —
 * it's the documented test escape hatch.
 *
 * Future readers: if this helper looks load-bearing, it is. Removing it
 * would silently break the corpus simulation test because the API and the
 * corpus generator have intentionally different active policies.
 */
async function seedDecisionsFromCorpus(
  client: pg.Pool,
  decisions: CorpusDecision[],
): Promise<void> {
  await client.query('TRUNCATE TABLE decisions');
  for (const d of decisions) {
    await client.query(
      `INSERT INTO decisions (
         receipt_hash, workspace_id, decision,
         triggered_rules, reasons,
         policy_version, evaluated_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
      [
        d.receipt_hash,
        WORKSPACE_ID,
        d.decision,
        JSON.stringify(d.triggered_rules),
        JSON.stringify(d.reasons),
        d.policy_version,
        d.evaluated_at,
      ],
    );
  }
}

describe.skipIf(!HAS_DB)('simulation against fixture corpus', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    await runMigrations(TEST_DATABASE_URL!);
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });

    app = Fastify({ logger: false });
    const config = {
      databaseUrl: TEST_DATABASE_URL!,
      jwksSource: 'memory:test',
      workspaceId: WORKSPACE_ID,
      port: 0,
      logLevel: 'silent',
    };
    registerReceiptRoutes(app, { pool, config, loadJwks: async () => JWKS });
    registerSimulateRoutes(app, { pool, config });
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

  function buildSimulationBody(sampleSize = 100) {
    return {
      candidate_policy: POLICY_V2,
      // Widen by a few hours on each side to bracket the corpus comfortably.
      from: '2026-04-18T00:00:00Z',
      to: '2026-05-20T00:00:00Z',
      sample_size: sampleSize,
    };
  }

  it('returns diffs that match the outcome-differing subset of the oracle', async () => {
    await ingestAll();
    await seedDecisionsFromCorpus(pool, DECISIONS);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/simulate',
      payload: buildSimulationBody(1000),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.receipts_evaluated).toBe(500);
    expect(body.diff_summary.total_diffs).toBe(OUTCOME_ORACLE.length);

    // Project the API sample to the (hash, actual, counterfactual) tuple and
    // compare against the oracle's outcome-diff entries. Both sides are
    // sorted by receipt_hash so the equality is order-stable.
    const apiTuples = body.sample
      .map(
        (s: {
          receipt_hash: string;
          actual_decision: string;
          counterfactual_decision: string;
        }) => ({
          receipt_hash: s.receipt_hash,
          actual: s.actual_decision,
          counterfactual: s.counterfactual_decision,
        }),
      )
      .sort((a: { receipt_hash: string }, b: { receipt_hash: string }) =>
        a.receipt_hash < b.receipt_hash ? -1 : 1,
      );
    const oracleTuples = OUTCOME_ORACLE.map((o) => ({
      receipt_hash: o.receipt_hash,
      actual: o.v1.decision,
      counterfactual: o.v2.decision,
    })).sort((a, b) => (a.receipt_hash < b.receipt_hash ? -1 : 1));
    expect(apiTuples).toEqual(oracleTuples);
  }, 120_000);

  it('produces deterministic samples across re-runs', async () => {
    await ingestAll();
    await seedDecisionsFromCorpus(pool, DECISIONS);

    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/simulate',
      payload: buildSimulationBody(10),
      headers: { 'content-type': 'application/json' },
    });
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/simulate',
      payload: buildSimulationBody(10),
      headers: { 'content-type': 'application/json' },
    });
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    const body1 = res1.json();
    const body2 = res2.json();
    expect(body1.sample).toEqual(body2.sample);
    expect(body1.sample).toHaveLength(10);

    // Sample must be the lex-first 10 of the 26 outcome diffs.
    const expectedFirst10 = OUTCOME_ORACLE.map((o) => o.receipt_hash)
      .sort()
      .slice(0, 10);
    expect(body1.sample.map((s: { receipt_hash: string }) => s.receipt_hash)).toEqual(
      expectedFirst10,
    );
  }, 120_000);

  it('counterfactual_counts + actual_counts each sum to receipts_evaluated', async () => {
    await ingestAll();
    await seedDecisionsFromCorpus(pool, DECISIONS);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/simulate',
      payload: buildSimulationBody(),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const cSum =
      body.counterfactual_counts.allow +
      body.counterfactual_counts.deny +
      body.counterfactual_counts.escalate;
    const aSum = body.actual_counts.allow + body.actual_counts.deny + body.actual_counts.escalate;
    expect(cSum).toBe(500);
    expect(aSum).toBe(500);
  }, 120_000);

  it('GET /v1/simulate/{job_id} returns 404 for any id (async path stubbed)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/simulate/does-not-exist' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('rejects candidate_policy passed as a string with the documented error message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/simulate',
      payload: {
        candidate_policy: 'demo-policy-v2',
        from: '2026-04-18T00:00:00Z',
        to: '2026-05-20T00:00:00Z',
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toMatch(/IMPLEMENTATION_STATUS\.md/);
  });

  it('rejects an out-of-order time window', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/simulate',
      payload: {
        candidate_policy: POLICY_V2,
        from: '2026-05-20T00:00:00Z',
        to: '2026-04-18T00:00:00Z',
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details?.field).toBe('to');
  });

  it('rejects malformed PolicyInput', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/simulate',
      payload: {
        candidate_policy: {
          rules: [{ id: 'x', type: 'not_a_real_type', outcome: 'deny', parameters: {} }],
        },
        from: '2026-04-18T00:00:00Z',
        to: '2026-05-20T00:00:00Z',
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details?.field).toBe('candidate_policy');
  });

  it('rejects sample_size out of range', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/simulate',
      payload: {
        candidate_policy: POLICY_V2,
        from: '2026-04-18T00:00:00Z',
        to: '2026-05-20T00:00:00Z',
        sample_size: 5000,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details?.field).toBe('sample_size');
  });
});

describe.skipIf(HAS_DB)('simulation corpus integration skipped (no TEST_DATABASE_URL)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
});
