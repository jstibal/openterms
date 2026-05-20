// Deterministic policy engine — TypeScript port of
// packages/openterms-py/openterms/policy.py. Same precedence (deny > escalate
// > allow), same per-evaluation budget contract, same timeout-as-deny semantic.

import { DISPATCH, monotonicSeconds } from './policy_rules.js';
import {
  type Decision,
  type DecisionOutcome,
  type EvalContext,
  type Policy,
  PolicyTimeoutError,
  type Rule,
  policyFromDict,
} from './policy_types.js';

export const DEFAULT_BUDGET_SECONDS = 0.005;

const PRECEDENCE: Record<DecisionOutcome, number> = { allow: 0, escalate: 1, deny: 2 };

function coercePolicy(policy: Policy | Record<string, unknown>): Policy {
  if (
    typeof policy === 'object' &&
    policy !== null &&
    !Array.isArray(policy) &&
    'version' in policy &&
    Array.isArray((policy as Policy).rules)
  ) {
    // Already a Policy: rules array of well-typed Rule. We still take a defensive
    // shallow copy via policyFromDict on the JSON-shape if it's a dict from JSON.
    const candidate = policy as Policy;
    // Probe: a Rule must have id+type+outcome+parameters keys present.
    if (
      candidate.rules.every(
        (r) =>
          typeof r === 'object' &&
          r !== null &&
          'id' in r &&
          'type' in r &&
          'outcome' in r &&
          'parameters' in r,
      )
    ) {
      return candidate;
    }
  }
  if (typeof policy === 'object' && policy !== null && !Array.isArray(policy)) {
    return policyFromDict(policy as Record<string, unknown>);
  }
  throw new TypeError('policy must be a Policy instance or a dict');
}

function evaluatedAt(receipt: Record<string, unknown>, ctx: EvalContext): string {
  if (ctx.evaluatedAt !== null && ctx.evaluatedAt !== undefined) return ctx.evaluatedAt;
  for (const key of ['created_at', 'timestamp']) {
    const v = receipt[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '1970-01-01T00:00:00Z';
}

function applyRule(
  rule: Rule,
  receipt: Record<string, unknown>,
  ctx: EvalContext,
): { fired: boolean; reason: string } {
  return DISPATCH[rule.type]!(rule, receipt, ctx);
}

export interface EvaluateOptions {
  aggregates?: Record<string, number>;
  budgetSeconds?: number;
  evaluatedAt?: string | null;
}

export function evaluate(
  receipt: Record<string, unknown>,
  policy: Policy | Record<string, unknown>,
  opts: EvaluateOptions = {},
): Decision {
  const budgetSeconds = opts.budgetSeconds ?? DEFAULT_BUDGET_SECONDS;
  const deadline = budgetSeconds > 0 ? monotonicSeconds() + budgetSeconds : null;
  const ctx: EvalContext = {
    aggregates: { ...(opts.aggregates ?? {}) },
    deadlineMonotonic: deadline,
    evaluatedAt: opts.evaluatedAt ?? null,
  };
  return evaluateWithContext(receipt, policy, ctx);
}

export function evaluateWithContext(
  receipt: Record<string, unknown>,
  policy: Policy | Record<string, unknown>,
  ctx: EvalContext,
): Decision {
  const pol = coercePolicy(policy);
  const triggered: string[] = [];
  const reasons: string[] = [];
  const firedOutcomes: DecisionOutcome[] = [];

  try {
    for (const rule of pol.rules) {
      if (ctx.deadlineMonotonic !== null && monotonicSeconds() > ctx.deadlineMonotonic) {
        throw new PolicyTimeoutError();
      }
      const result = applyRule(rule, receipt, ctx);
      if (result.fired) {
        triggered.push(rule.id);
        reasons.push(result.reason);
        firedOutcomes.push(rule.outcome);
      }
    }
  } catch (err) {
    if (err instanceof PolicyTimeoutError) {
      reasons.push('TIMEOUT: rule evaluation exceeded the per-evaluation budget');
      return {
        decision: 'deny',
        triggered_rules: [...triggered],
        reasons: [...reasons],
        policy_version: pol.version,
        evaluated_at: evaluatedAt(receipt, ctx),
      };
    }
    throw err;
  }

  let final: DecisionOutcome = 'allow';
  if (firedOutcomes.length > 0) {
    final = firedOutcomes.reduce((acc, o) => (PRECEDENCE[o] > PRECEDENCE[acc] ? o : acc));
  }

  return {
    decision: final,
    triggered_rules: triggered,
    reasons,
    policy_version: pol.version,
    evaluated_at: evaluatedAt(receipt, ctx),
  };
}
