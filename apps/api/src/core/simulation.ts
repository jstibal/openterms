// Simulation engine — replays a candidate policy against historical receipts
// and reports counterfactual decisions, diffs against the actually-recorded
// decisions, and a deterministic sample of differing receipts.
//
// Design contract (frozen for this session):
//
//   • Receipts are walked in (ts ASC, receipt_id ASC) so daily_limit
//     aggregates can be reconstructed in the same order the original
//     ingest computed them.
//   • daily_limit aggregates are recomputed in-process. We widen the read
//     window to 00:00 UTC of the from-date so a from in the middle of a
//     day has correct prior-day-running-total context; pre-window receipts
//     populate the aggregate state but do not contribute to
//     receipts_evaluated or to the diff. See BUILD_BRIEF Step 8 and the
//     prior-session design memo for the rationale.
//   • The per-evaluation budget is DISABLED (budgetSeconds=0). Simulations
//     must be deterministic across machines and CI nodes; the live engine's
//     timeout-as-deny semantic is intentionally not in play here.
//   • ENGINE_ERROR-style placeholders on the actual side are taken verbatim
//     from the stored decision row. The counterfactual side always
//     re-evaluates fresh under the candidate policy.
//   • Diffs are counted on decision-outcome change only. by_rule is the
//     symmetric difference of triggered_rules between actual and
//     counterfactual, pair-counted (receipt × differing rule).
//   • The sample is the diffs sorted by receipt_hash ascending (hex lex)
//     and sliced to sample_size. canonical_hash is content-addressed and
//     globally unique, so the sort is stable across re-runs.

import { evaluate, type Decision, type DecisionOutcome, type Policy } from '@openterms-ai/sdk';

import type { Queryable } from '../db/receipts.js';

export interface SimulationInput {
  workspaceId: string;
  candidatePolicy: Policy;
  from: Date;
  to: Date;
  sampleSize: number;
}

export interface SimulationCounts {
  allow: number;
  deny: number;
  escalate: number;
}

export interface SimulationSampleEntry {
  receipt_hash: string;
  actual_decision: DecisionOutcome;
  counterfactual_decision: DecisionOutcome;
  counterfactual_reasons: string[];
}

export interface SimulationResult {
  counterfactual_counts: SimulationCounts;
  actual_counts: SimulationCounts;
  diff_summary: {
    total_diffs: number;
    by_rule: Record<string, number>;
    by_tool: Record<string, number>;
  };
  sample: SimulationSampleEntry[];
  evaluated_at: string;
  receipts_evaluated: number;
}

interface WalkRow {
  canonical_hash: string;
  raw_receipt: Record<string, unknown>;
  ts: Date;
  receipt_id: string;
  agent_id: string;
  amount_charged: number;
  actual_decision: DecisionOutcome | null;
  actual_triggered_rules: string[];
}

// The simulation SQL is a deliberate copy-paste of receipts_query.ts's join
// pattern rather than a shared helper. The shapes diverge enough (we need
// agent_id and amount_charged out of receipts; we need decision + triggered
// rules out of decisions; we ignore reasons and policy_version on the actual
// side) that abstracting now would lose more clarity than it would save.
const WALK_SQL = `
  SELECT
    r.canonical_hash,
    r.raw_receipt,
    r.ts,
    r.receipt_id,
    r.agent_id,
    r.amount_charged,
    d.decision         AS actual_decision,
    d.triggered_rules  AS actual_triggered_rules
  FROM receipts r
  LEFT JOIN decisions d ON d.receipt_hash = r.canonical_hash
  WHERE r.workspace_id = $1
    AND r.ts >= $2
    AND r.ts <= $3
  ORDER BY r.ts ASC, r.receipt_id ASC
`;

export async function countReceiptsInWindow(
  q: Queryable,
  workspaceId: string,
  from: Date,
  to: Date,
): Promise<number> {
  const result = await q.query(
    'SELECT COUNT(*)::bigint AS c FROM receipts WHERE workspace_id = $1 AND ts >= $2 AND ts <= $3',
    [workspaceId, from, to],
  );
  return Number(result.rows[0]?.c ?? 0);
}

// utcDayStart(d) → 00:00:00Z of d's UTC day. Used both for widening the
// aggregate-read window and for keying the per-day running total during
// the walk (workspace-wide; see the runningTotals comment below).
export function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcDayKey(d: Date): string {
  return utcDayStart(d).toISOString();
}

function dailyLimitRuleIds(policy: Policy): string[] {
  return policy.rules.filter((r) => r.type === 'daily_limit').map((r) => r.id);
}

// Symmetric difference, pair-counted: every rule that fired on exactly one
// side of the (actual, counterfactual) split contributes one tick to by_rule.
function symmetricDifference(a: readonly string[], b: readonly string[]): string[] {
  const inA = new Set(a);
  const inB = new Set(b);
  const out: string[] = [];
  for (const r of inA) if (!inB.has(r)) out.push(r);
  for (const r of inB) if (!inA.has(r)) out.push(r);
  return out;
}

function extractToolId(receipt: Record<string, unknown>): string | null {
  const ctx = receipt.action_context as
    | { ors?: { commitments?: { tool_id?: string } } }
    | undefined;
  const tid = ctx?.ors?.commitments?.tool_id;
  return typeof tid === 'string' && tid.length > 0 ? tid : null;
}

export interface RunSimulationOptions {
  // Pre-loaded rows, useful for unit tests that bypass the database. When
  // provided, the simulation skips the DB read entirely and uses these rows
  // in the order given (caller is responsible for the ts/receipt_id ordering
  // contract). The window-widening step is also the caller's responsibility
  // in this mode.
  rows?: WalkRow[];
}

export async function runSimulation(
  q: Queryable | null,
  input: SimulationInput,
  opts: RunSimulationOptions = {},
): Promise<SimulationResult> {
  const { workspaceId, candidatePolicy, from, to, sampleSize } = input;

  // Aggregate-window widening: read receipts from 00:00 UTC of the from-day
  // so a mid-day `from` still has correct prior-receipt daily_limit state.
  // Pre-from receipts populate the running totals but contribute nothing
  // toward receipts_evaluated, actual_counts, counterfactual_counts, or the
  // diff. (Per the prior-session design memo, item 8.)
  const readFrom = utcDayStart(from);

  let rows: WalkRow[];
  if (opts.rows) {
    rows = opts.rows;
  } else {
    if (!q) throw new Error('runSimulation requires a Queryable when opts.rows is not provided');
    const result = await q.query(WALK_SQL, [workspaceId, readFrom, to]);
    rows = result.rows.map((r: Record<string, unknown>) => ({
      canonical_hash: r.canonical_hash as string,
      raw_receipt: r.raw_receipt as Record<string, unknown>,
      ts: r.ts as Date,
      receipt_id: r.receipt_id as string,
      agent_id: r.agent_id as string,
      amount_charged: Number(r.amount_charged),
      actual_decision: (r.actual_decision as DecisionOutcome | null) ?? null,
      actual_triggered_rules: (r.actual_triggered_rules as string[] | null) ?? [],
    }));
  }

  const dailyLimitIds = dailyLimitRuleIds(candidatePolicy);
  // Aggregate key is utc_day only, NOT (agent_id, utc_day). The corpus
  // generator's compute_daily_aggregates in
  // packages/openterms-py/scripts/generate_corpus.py uses a workspace-wide
  // per-day running total — see the per_day dict there. The simulation
  // must reconstruct the same shape, so a single per-day bucket is what
  // we maintain here. (This is a deliberate departure from a per-(agent,
  // day) partition that an earlier design draft proposed.)
  const runningTotals = new Map<string, number>(); // key: utc_day → cents
  const counterfactual: SimulationCounts = { allow: 0, deny: 0, escalate: 0 };
  const actual: SimulationCounts = { allow: 0, deny: 0, escalate: 0 };
  const byRule: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  const diffs: SimulationSampleEntry[] = [];
  let receiptsEvaluated = 0;

  for (const row of rows) {
    const ts = row.ts instanceof Date ? row.ts : new Date(row.ts as unknown as string);
    const aggKey = utcDayKey(ts);
    const priorToday = runningTotals.get(aggKey) ?? 0;

    const inWindow = ts.getTime() >= from.getTime() && ts.getTime() <= to.getTime();

    if (inWindow) {
      // Build aggregates: every daily_limit rule in the candidate policy
      // sees the same per-(agent, day) running total. Rule ids that are not
      // daily_limit get nothing — the engine only consults aggregates for
      // rule types that opt in (see policy_rules.ts).
      const aggregates: Record<string, number> = {};
      for (const id of dailyLimitIds) aggregates[id] = priorToday;

      const counterDecision: Decision = evaluate(row.raw_receipt, candidatePolicy, {
        aggregates,
        budgetSeconds: 0,
        evaluatedAt:
          (row.raw_receipt.created_at as string | undefined) ??
          (row.raw_receipt.timestamp as string | undefined) ??
          null,
      });

      counterfactual[counterDecision.decision] += 1;

      // Actual side: a missing decision row (NULL from the LEFT JOIN) means
      // the receipt was ingested but never had a decision written — treat as
      // 'allow' for accounting purposes (matches the ingest-time fallback in
      // policy.ts when no rules fire). Document this so future-me knows.
      const actualOutcome: DecisionOutcome = row.actual_decision ?? 'allow';
      actual[actualOutcome] += 1;

      if (counterDecision.decision !== actualOutcome) {
        const diffEntry: SimulationSampleEntry = {
          receipt_hash: row.canonical_hash,
          actual_decision: actualOutcome,
          counterfactual_decision: counterDecision.decision,
          counterfactual_reasons: [...counterDecision.reasons],
        };
        diffs.push(diffEntry);

        // by_rule: symmetric difference of triggered_rules pair-counts.
        const diffRules = symmetricDifference(
          row.actual_triggered_rules,
          counterDecision.triggered_rules,
        );
        for (const r of diffRules) byRule[r] = (byRule[r] ?? 0) + 1;

        // by_tool: one tick per differing receipt, keyed by its tool_id or
        // a synthetic 'unknown' bucket for receipts without commitments.
        const tool = extractToolId(row.raw_receipt) ?? 'unknown';
        byTool[tool] = (byTool[tool] ?? 0) + 1;
      }

      receiptsEvaluated += 1;
    }

    // Update the running aggregate AFTER evaluation, matching the
    // "amount_today_total is prior receipts only" contract that the corpus
    // generator and the live policy engine both rely on. Pre-window rows
    // still update the total so in-window evaluations see the correct
    // baseline.
    runningTotals.set(aggKey, priorToday + row.amount_charged);
  }

  // Determinism: lex-sort by receipt_hash, then slice. canonical_hash is a
  // 64-char SHA-256 hex string, so a default string comparator gives a
  // stable, reproducible ordering.
  diffs.sort((a, b) =>
    a.receipt_hash < b.receipt_hash ? -1 : a.receipt_hash > b.receipt_hash ? 1 : 0,
  );
  const sample = diffs.slice(0, sampleSize);

  return {
    counterfactual_counts: counterfactual,
    actual_counts: actual,
    diff_summary: {
      total_diffs: diffs.length,
      by_rule: byRule,
      by_tool: byTool,
    },
    sample,
    evaluated_at: new Date().toISOString(),
    receipts_evaluated: receiptsEvaluated,
  };
}

// Exported for tests that need to construct WalkRow values directly.
export type { WalkRow };
