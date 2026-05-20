// Types for the OpenTerms deterministic policy engine — TypeScript port of
// packages/openterms-py/openterms/policy_types.py. Cross-language parity is
// enforced by tests/policy.parity.test.ts against the shared fixture corpus
// at packages/openterms-py/tests/fixtures/policy/.

export type DecisionOutcome = 'allow' | 'deny' | 'escalate';

export type RuleType =
  | 'max_amount'
  | 'daily_limit'
  | 'action_type_allowlist'
  | 'action_type_denylist'
  | 'url_prefix_allowlist'
  | 'url_prefix_denylist'
  | 'escalation_threshold'
  | 'tool_id_allowlist'
  | 'args_pattern_match'
  | 'post_state_assertion';

export const VALID_OUTCOMES: readonly DecisionOutcome[] = ['allow', 'deny', 'escalate'];
export const VALID_RULE_TYPES: readonly RuleType[] = [
  'max_amount',
  'daily_limit',
  'action_type_allowlist',
  'action_type_denylist',
  'url_prefix_allowlist',
  'url_prefix_denylist',
  'escalation_threshold',
  'tool_id_allowlist',
  'args_pattern_match',
  'post_state_assertion',
];

export interface Rule {
  id: string;
  type: RuleType;
  outcome: DecisionOutcome;
  parameters: Record<string, unknown>;
}

export interface Policy {
  version: string;
  rules: Rule[];
}

export interface RuleResult {
  fired: boolean;
  reason: string;
}

export interface EvalContext {
  aggregates: Record<string, number>;
  deadlineMonotonic: number | null;
  evaluatedAt: string | null;
}

export interface Decision {
  decision: DecisionOutcome;
  triggered_rules: string[];
  reasons: string[];
  policy_version: string;
  evaluated_at: string;
}

export class PolicyTimeoutError extends Error {
  constructor() {
    super('Policy evaluation exceeded the per-evaluation budget');
    this.name = 'PolicyTimeoutError';
  }
}

export function ruleFromDict(d: Record<string, unknown>): Rule {
  for (const k of ['id', 'type', 'outcome', 'parameters'] as const) {
    if (!(k in d)) {
      throw new Error(`Rule is missing required field '${k}'`);
    }
  }
  if (!VALID_RULE_TYPES.includes(d.type as RuleType)) {
    throw new Error(`Unknown rule type: '${String(d.type)}'`);
  }
  if (!VALID_OUTCOMES.includes(d.outcome as DecisionOutcome)) {
    throw new Error(`Invalid outcome: '${String(d.outcome)}'`);
  }
  if (typeof d.parameters !== 'object' || d.parameters === null || Array.isArray(d.parameters)) {
    throw new Error('Rule.parameters must be an object');
  }
  return {
    id: String(d.id),
    type: d.type as RuleType,
    outcome: d.outcome as DecisionOutcome,
    parameters: { ...(d.parameters as Record<string, unknown>) },
  };
}

export function policyFromDict(d: Record<string, unknown>): Policy {
  const version = String(d.version ?? 'inline');
  const rawRules = d.rules ?? [];
  if (!Array.isArray(rawRules)) {
    throw new Error('Policy.rules must be a list');
  }
  return {
    version,
    rules: rawRules.map((r) => ruleFromDict(r as Record<string, unknown>)),
  };
}

export function decisionToDict(d: Decision): Record<string, unknown> {
  return {
    decision: d.decision,
    triggered_rules: [...d.triggered_rules],
    reasons: [...d.reasons],
    policy_version: d.policy_version,
    evaluated_at: d.evaluated_at,
  };
}
