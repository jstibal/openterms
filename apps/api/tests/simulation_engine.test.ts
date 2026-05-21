// Simulation engine unit tests — exercise the pure engine in
// core/simulation.ts against synthetic in-memory WalkRow inputs. No
// database, no HTTP. The fixture corpus integration test (see
// simulation_corpus.test.ts) covers the DB-backed walk; here we lock the
// engine's diff accounting, aggregate reconstruction, and sample
// determinism against hand-built cases.

import { describe, expect, it } from 'vitest';

import type { Policy } from '../src/core/policy_types.js';
import { runSimulation, utcDayStart, type WalkRow } from '../src/core/simulation.js';

function row(partial: Partial<WalkRow> & { canonical_hash: string; ts: string }): WalkRow {
  return {
    canonical_hash: partial.canonical_hash,
    raw_receipt: partial.raw_receipt ?? {
      created_at: partial.ts,
      amount_charged: partial.amount_charged ?? 0,
    },
    ts: new Date(partial.ts),
    receipt_id: partial.receipt_id ?? `r-${partial.canonical_hash.slice(0, 8)}`,
    agent_id: partial.agent_id ?? 'agent-a',
    amount_charged: partial.amount_charged ?? 0,
    actual_decision: partial.actual_decision ?? 'allow',
    actual_triggered_rules: partial.actual_triggered_rules ?? [],
  };
}

// A canonical-hash-shaped (64 hex chars) string built from a tag so the
// sorted order of the test's diffs is predictable.
function hash(tag: string): string {
  const pad = '0'.repeat(64 - tag.length);
  return pad + tag;
}

describe('runSimulation — pure engine', () => {
  const denyOverFiveK: Policy = {
    version: 'inline',
    rules: [
      {
        id: 'max_amount',
        type: 'max_amount',
        outcome: 'deny',
        parameters: { threshold: 5000 },
      },
    ],
  };

  it('produces zero diffs when actual matches counterfactual', async () => {
    const rows: WalkRow[] = [
      row({
        canonical_hash: hash('aa'),
        ts: '2026-01-01T10:00:00Z',
        amount_charged: 1000,
        actual_decision: 'allow',
      }),
      row({
        canonical_hash: hash('bb'),
        ts: '2026-01-01T11:00:00Z',
        amount_charged: 6000,
        actual_decision: 'deny',
        actual_triggered_rules: ['max_amount'],
      }),
    ];
    const result = await runSimulation(
      null,
      {
        workspaceId: 'w',
        candidatePolicy: denyOverFiveK,
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2026-01-02T00:00:00Z'),
        sampleSize: 100,
      },
      { rows },
    );
    expect(result.diff_summary.total_diffs).toBe(0);
    expect(result.counterfactual_counts).toEqual({ allow: 1, deny: 1, escalate: 0 });
    expect(result.actual_counts).toEqual({ allow: 1, deny: 1, escalate: 0 });
    expect(result.receipts_evaluated).toBe(2);
    expect(result.sample).toEqual([]);
  });

  it('records outcome-only diffs and pair-counts by_rule via symmetric difference', async () => {
    // actual fired {url_prefix_allowlist, daily_limit} with outcome allow (fake setup),
    // counterfactual fires only {max_amount} with outcome deny. Symmetric diff = 3 rules.
    const rows: WalkRow[] = [
      row({
        canonical_hash: hash('cc'),
        ts: '2026-01-01T10:00:00Z',
        amount_charged: 9000,
        actual_decision: 'allow',
        actual_triggered_rules: ['url_prefix_allowlist', 'daily_limit'],
        raw_receipt: {
          created_at: '2026-01-01T10:00:00Z',
          amount_charged: 9000,
          action_context: { ors: { commitments: { tool_id: 'stripe.charge' } } },
        },
      }),
    ];
    const result = await runSimulation(
      null,
      {
        workspaceId: 'w',
        candidatePolicy: denyOverFiveK,
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2026-01-02T00:00:00Z'),
        sampleSize: 100,
      },
      { rows },
    );
    expect(result.diff_summary.total_diffs).toBe(1);
    expect(result.diff_summary.by_rule).toEqual({
      url_prefix_allowlist: 1,
      daily_limit: 1,
      max_amount: 1,
    });
    expect(result.diff_summary.by_tool).toEqual({ 'stripe.charge': 1 });
    expect(result.sample).toHaveLength(1);
    expect(result.sample[0].counterfactual_decision).toBe('deny');
    expect(result.sample[0].actual_decision).toBe('allow');
  });

  it('buckets receipts without a tool_id under "unknown" in by_tool', async () => {
    const rows: WalkRow[] = [
      row({
        canonical_hash: hash('dd'),
        ts: '2026-01-01T10:00:00Z',
        amount_charged: 9000,
        actual_decision: 'allow',
        raw_receipt: { created_at: '2026-01-01T10:00:00Z', amount_charged: 9000 },
      }),
    ];
    const result = await runSimulation(
      null,
      {
        workspaceId: 'w',
        candidatePolicy: denyOverFiveK,
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2026-01-02T00:00:00Z'),
        sampleSize: 100,
      },
      { rows },
    );
    expect(result.diff_summary.by_tool).toEqual({ unknown: 1 });
  });

  it('reconstructs daily_limit aggregates with a workspace-wide per-day running total', async () => {
    // Policy: deny when prior amount today + this receipt's amount would exceed 10k.
    // The engine reads aggregates[<rule_id>] as the PRIOR running total. The
    // aggregate is keyed by UTC day ALONE — see compute_daily_aggregates in
    // packages/openterms-py/scripts/generate_corpus.py. Receipts across all
    // agents on the same day contribute to the same bucket.
    const dailyLimit: Policy = {
      version: 'inline',
      rules: [
        {
          id: 'daily_limit',
          type: 'daily_limit',
          outcome: 'deny',
          parameters: { threshold: 10000, window: 'utc_day' },
        },
      ],
    };
    const rows: WalkRow[] = [
      row({
        canonical_hash: hash('e1'),
        ts: '2026-01-01T08:00:00Z',
        agent_id: 'agent-a',
        amount_charged: 6000,
        actual_decision: 'allow',
      }),
      // Different agent on the same UTC day — DOES contribute to the bucket.
      row({
        canonical_hash: hash('e2'),
        ts: '2026-01-01T08:30:00Z',
        agent_id: 'agent-b',
        amount_charged: 3000,
        actual_decision: 'allow',
      }),
      // Third receipt on the same day pushes the day-total past 10k.
      row({
        canonical_hash: hash('e3'),
        ts: '2026-01-01T09:00:00Z',
        agent_id: 'agent-c',
        amount_charged: 2000,
        actual_decision: 'allow',
      }),
      // Next-day receipt — bucket resets, no diff.
      row({
        canonical_hash: hash('e4'),
        ts: '2026-01-02T08:00:00Z',
        agent_id: 'agent-a',
        amount_charged: 1000,
        actual_decision: 'allow',
      }),
    ];
    const result = await runSimulation(
      null,
      {
        workspaceId: 'w',
        candidatePolicy: dailyLimit,
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2026-01-03T00:00:00Z'),
        sampleSize: 100,
      },
      { rows },
    );
    // e1 prior=0     → allow.   bucket=6000
    // e2 prior=6000  → allow.   bucket=9000
    // e3 prior=9000  → deny (engine semantic: prior + this ≥ threshold). bucket=11000
    // e4 prior=0 (new day) → allow.
    expect(result.counterfactual_counts).toEqual({ allow: 3, deny: 1, escalate: 0 });
    expect(result.diff_summary.total_diffs).toBe(1);
    expect(result.sample[0].receipt_hash).toBe(hash('e3'));
  });

  it('uses pre-window rows for aggregate state but does not count them as evaluated', async () => {
    // Pre-window row (before `from`) at 06:00 contributes its amount to the
    // running total but is not in counterfactual_counts / actual_counts /
    // receipts_evaluated. The in-window row at 08:00 sees the prior 7000.
    const dailyLimit: Policy = {
      version: 'inline',
      rules: [
        {
          id: 'daily_limit',
          type: 'daily_limit',
          outcome: 'deny',
          parameters: { threshold: 10000, window: 'utc_day' },
        },
      ],
    };
    const rows: WalkRow[] = [
      row({
        canonical_hash: hash('pre'),
        ts: '2026-01-01T06:00:00Z',
        agent_id: 'agent-a',
        amount_charged: 7000,
        actual_decision: 'allow',
      }),
      row({
        canonical_hash: hash('inw'),
        ts: '2026-01-01T08:00:00Z',
        agent_id: 'agent-a',
        amount_charged: 4000,
        actual_decision: 'allow',
      }),
    ];
    const result = await runSimulation(
      null,
      {
        workspaceId: 'w',
        candidatePolicy: dailyLimit,
        from: new Date('2026-01-01T07:00:00Z'),
        to: new Date('2026-01-01T23:00:00Z'),
        sampleSize: 100,
      },
      { rows },
    );
    expect(result.receipts_evaluated).toBe(1);
    // 7000 + 4000 = 11000 ≥ 10000 → counterfactual denies.
    expect(result.counterfactual_counts).toEqual({ allow: 0, deny: 1, escalate: 0 });
    expect(result.actual_counts).toEqual({ allow: 1, deny: 0, escalate: 0 });
    expect(result.diff_summary.total_diffs).toBe(1);
  });

  it('treats ENGINE_ERROR-style stored decisions verbatim on the actual side', async () => {
    // Simulated ENGINE_ERROR placeholder: stored row carries decision='deny'
    // with a TIMEOUT/ENGINE_ERROR reason string but no triggered rules. The
    // simulation should compare counterfactual against that 'deny' verbatim.
    const rows: WalkRow[] = [
      row({
        canonical_hash: hash('err'),
        ts: '2026-01-01T08:00:00Z',
        amount_charged: 100, // counterfactual under denyOverFiveK → allow
        actual_decision: 'deny',
        actual_triggered_rules: [],
      }),
    ];
    const result = await runSimulation(
      null,
      {
        workspaceId: 'w',
        candidatePolicy: denyOverFiveK,
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2026-01-02T00:00:00Z'),
        sampleSize: 100,
      },
      { rows },
    );
    expect(result.diff_summary.total_diffs).toBe(1);
    expect(result.sample[0].actual_decision).toBe('deny');
    expect(result.sample[0].counterfactual_decision).toBe('allow');
  });

  it('returns all diffs lex-sorted when total_diffs < sample_size', async () => {
    const rows: WalkRow[] = [
      row({
        canonical_hash: hash('z9'),
        ts: '2026-01-01T10:00:00Z',
        amount_charged: 9000,
        actual_decision: 'allow',
      }),
      row({
        canonical_hash: hash('a1'),
        ts: '2026-01-01T11:00:00Z',
        amount_charged: 9000,
        actual_decision: 'allow',
      }),
      row({
        canonical_hash: hash('m5'),
        ts: '2026-01-01T12:00:00Z',
        amount_charged: 9000,
        actual_decision: 'allow',
      }),
    ];
    const result = await runSimulation(
      null,
      {
        workspaceId: 'w',
        candidatePolicy: denyOverFiveK,
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2026-01-02T00:00:00Z'),
        sampleSize: 100,
      },
      { rows },
    );
    expect(result.diff_summary.total_diffs).toBe(3);
    expect(result.sample.map((s) => s.receipt_hash)).toEqual([hash('a1'), hash('m5'), hash('z9')]);
  });

  it('truncates sample to sample_size and stays deterministic across re-runs', async () => {
    // Build 20 differing receipts; sample_size=5 should return the lex-first 5
    // and be identical across two runs.
    const rows: WalkRow[] = [];
    for (let i = 0; i < 20; i += 1) {
      const tag = (i + 100).toString(16).padStart(4, '0'); // 0064..0077 hex
      // Spread across two days at unique HH:MM stamps. dailyLimit is not in
      // the policy here so the per-day bucket value is irrelevant — we just
      // need each receipt to be a valid Date.
      const day = i < 12 ? '2026-01-01' : '2026-01-02';
      const minutesIntoDay = i * 30;
      const hh = Math.floor(minutesIntoDay / 60)
        .toString()
        .padStart(2, '0');
      const mm = (minutesIntoDay % 60).toString().padStart(2, '0');
      rows.push(
        row({
          canonical_hash: hash(tag),
          ts: `${day}T${hh}:${mm}:00Z`,
          amount_charged: 9000,
          actual_decision: 'allow',
        }),
      );
    }
    const input = {
      workspaceId: 'w',
      candidatePolicy: denyOverFiveK,
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-01-03T00:00:00Z'),
      sampleSize: 5,
    };
    const a = await runSimulation(null, input, { rows });
    const b = await runSimulation(null, input, { rows });
    expect(a.sample).toEqual(b.sample);
    expect(a.sample).toHaveLength(5);
    const sortedAll = [...rows].map((r) => r.canonical_hash).sort();
    expect(a.sample.map((s) => s.receipt_hash)).toEqual(sortedAll.slice(0, 5));
  });

  it('utcDayStart floors to 00:00:00Z of the calendar day', () => {
    expect(utcDayStart(new Date('2026-01-05T17:42:11.123Z')).toISOString()).toBe(
      '2026-01-05T00:00:00.000Z',
    );
    expect(utcDayStart(new Date('2026-01-05T00:00:00.000Z')).toISOString()).toBe(
      '2026-01-05T00:00:00.000Z',
    );
  });
});
