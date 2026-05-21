// Per-rule evaluators — TypeScript port of
// packages/openterms-py/openterms/policy_rules.py. Reason strings are matched
// character-for-character against the Python output: dashboards group by the
// uppercase prefix and the substring assertions in the fixture corpus rely on
// the exact wording past the prefix.

import { VALID_OPS, matchOne, resolvePath } from './policy_pattern.js';
import {
  type EvalContext,
  PolicyTimeoutError,
  type Rule,
  type RuleResult,
} from './policy_types.js';

const VALID_DAILY_WINDOWS = ['utc_day', 'rolling_24h'] as const;

// Mirror Python's repr() for the kinds of values policy reasons reference:
// strings, null/None, numbers. ASCII-only strings get single-quoted with a
// minimal escape set, which matches Python's default for the values in our
// fixture corpus (no embedded apostrophes).
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'string') {
    const escaped = v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `'${escaped}'`;
  }
  return String(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && !Number.isNaN(v);
}

function requireInt(params: Record<string, unknown>, key: string, ruleId: string): number {
  if (!(key in params)) {
    throw new Error(`Rule '${ruleId}' parameters missing '${key}'`);
  }
  const val = params[key];
  if (!isInt(val) || typeof val === 'boolean') {
    throw new Error(`Rule '${ruleId}' parameter '${key}' must be an integer`);
  }
  return val as number;
}

function requireStringList(params: Record<string, unknown>, key: string, ruleId: string): string[] {
  if (!(key in params)) {
    throw new Error(`Rule '${ruleId}' parameters missing '${key}'`);
  }
  const val = params[key];
  if (!Array.isArray(val) || !val.every((v) => typeof v === 'string')) {
    throw new Error(`Rule '${ruleId}' parameter '${key}' must be a list of strings`);
  }
  return val as string[];
}

function receiptAmount(receipt: Record<string, unknown>, ruleId: string): number {
  const v = receipt.amount_charged;
  if (!isInt(v)) {
    throw new Error(
      `Rule '${ruleId}': receipt.amount_charged must be an integer (ORS minor units)`,
    );
  }
  return v;
}

export function evalMaxAmount(
  rule: Rule,
  receipt: Record<string, unknown>,
  _ctx: EvalContext,
): RuleResult {
  const threshold = requireInt(rule.parameters, 'threshold', rule.id);
  const amount = receiptAmount(receipt, rule.id);
  if (amount > threshold) {
    return {
      fired: true,
      reason: `MAX_AMOUNT: amount_charged ${amount} exceeds threshold ${threshold}`,
    };
  }
  return { fired: false, reason: '' };
}

export function evalDailyLimit(
  rule: Rule,
  receipt: Record<string, unknown>,
  ctx: EvalContext,
): RuleResult {
  const threshold = requireInt(rule.parameters, 'threshold', rule.id);
  const window = (rule.parameters.window as string | undefined) ?? 'utc_day';
  if (!(VALID_DAILY_WINDOWS as readonly string[]).includes(window)) {
    throw new Error(
      `Rule '${rule.id}': window must be one of ${JSON.stringify(VALID_DAILY_WINDOWS)}, got '${window}'`,
    );
  }
  const prior = ctx.aggregates[rule.id] ?? 0;
  if (!isInt(prior) || typeof prior === 'boolean') {
    throw new Error(`Rule '${rule.id}': aggregate value for this rule must be an integer`);
  }
  const total = prior + receiptAmount(receipt, rule.id);
  if (total > threshold) {
    return {
      fired: true,
      reason: `DAILY_LIMIT: cumulative amount ${total} in window ${window} exceeds threshold ${threshold}`,
    };
  }
  return { fired: false, reason: '' };
}

export function evalActionTypeAllowlist(
  rule: Rule,
  receipt: Record<string, unknown>,
  _ctx: EvalContext,
): RuleResult {
  const allowed = requireStringList(rule.parameters, 'allowed', rule.id);
  const actionType = receipt.action_type;
  if (typeof actionType !== 'string' || !allowed.includes(actionType)) {
    return {
      fired: true,
      reason: `ACTION_TYPE_ALLOWLIST: action_type ${pyRepr(actionType)} is not on the allow list`,
    };
  }
  return { fired: false, reason: '' };
}

export function evalActionTypeDenylist(
  rule: Rule,
  receipt: Record<string, unknown>,
  _ctx: EvalContext,
): RuleResult {
  const denied = requireStringList(rule.parameters, 'denied', rule.id);
  const actionType = receipt.action_type;
  if (typeof actionType === 'string' && denied.includes(actionType)) {
    return {
      fired: true,
      reason: `ACTION_TYPE_DENYLIST: action_type ${pyRepr(actionType)} is on the deny list`,
    };
  }
  return { fired: false, reason: '' };
}

function urlSource(
  rule: Rule,
  receipt: Record<string, unknown>,
): { field: string; value: unknown } {
  const sourceField = (rule.parameters.source_field as string | undefined) ?? 'terms_url';
  if (typeof sourceField !== 'string') {
    throw new Error(`Rule '${rule.id}': source_field must be a string`);
  }
  return { field: sourceField, value: resolvePath(receipt, sourceField) };
}

export function evalUrlPrefixAllowlist(
  rule: Rule,
  receipt: Record<string, unknown>,
  _ctx: EvalContext,
): RuleResult {
  const allowed = requireStringList(rule.parameters, 'allowed', rule.id);
  const { field, value } = urlSource(rule, receipt);
  const text = typeof value === 'string' ? value : '';
  if (!allowed.some((prefix) => text.startsWith(prefix))) {
    return {
      fired: true,
      reason: `URL_PREFIX_ALLOWLIST: ${field} ${pyRepr(text)} does not match any allowed prefix`,
    };
  }
  return { fired: false, reason: '' };
}

export function evalUrlPrefixDenylist(
  rule: Rule,
  receipt: Record<string, unknown>,
  _ctx: EvalContext,
): RuleResult {
  const denied = requireStringList(rule.parameters, 'denied', rule.id);
  const { field, value } = urlSource(rule, receipt);
  const text = typeof value === 'string' ? value : '';
  for (const prefix of denied) {
    if (text.startsWith(prefix)) {
      return {
        fired: true,
        reason: `URL_PREFIX_DENYLIST: ${field} ${pyRepr(text)} starts with denied prefix ${pyRepr(prefix)}`,
      };
    }
  }
  return { fired: false, reason: '' };
}

export function evalEscalationThreshold(
  rule: Rule,
  receipt: Record<string, unknown>,
  _ctx: EvalContext,
): RuleResult {
  const threshold = requireInt(rule.parameters, 'threshold', rule.id);
  const amount = receiptAmount(receipt, rule.id);
  if (amount >= threshold) {
    return {
      fired: true,
      reason: `ESCALATION_THRESHOLD: amount_charged ${amount} meets escalation threshold ${threshold}`,
    };
  }
  return { fired: false, reason: '' };
}

export function evalToolIdAllowlist(
  rule: Rule,
  receipt: Record<string, unknown>,
  _ctx: EvalContext,
): RuleResult {
  const allowed = requireStringList(rule.parameters, 'allowed', rule.id);
  const toolId = resolvePath(receipt, 'action_context.ors.commitments.tool_id');
  if (toolId === null || toolId === undefined) {
    return {
      fired: true,
      reason: 'TOOL_ID_ALLOWLIST: tool_id absent from receipt commitments',
    };
  }
  if (typeof toolId !== 'string' || !allowed.includes(toolId)) {
    return {
      fired: true,
      reason: `TOOL_ID_ALLOWLIST: tool_id ${pyRepr(toolId)} is not in the allow list`,
    };
  }
  return { fired: false, reason: '' };
}

export function evalArgsPatternMatch(
  rule: Rule,
  receipt: Record<string, unknown>,
  ctx: EvalContext,
): RuleResult {
  const patterns = rule.parameters.patterns;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error(`Rule '${rule.id}': parameters.patterns must be a non-empty list`);
  }
  const mode = (rule.parameters.mode as string | undefined) ?? 'any';
  if (mode !== 'any' && mode !== 'all') {
    throw new Error(`Rule '${rule.id}': mode must be 'any' or 'all', got '${mode}'`);
  }

  const matches: Array<[string, string]> = [];
  for (const pat of patterns) {
    if (ctx.deadlineMonotonic !== null && monotonicSeconds() > ctx.deadlineMonotonic) {
      throw new PolicyTimeoutError();
    }
    if (typeof pat !== 'object' || pat === null || Array.isArray(pat)) {
      throw new Error(`Rule '${rule.id}': each pattern must be an object`);
    }
    const p = pat as Record<string, unknown>;
    const path = p.path;
    const op = p.op;
    const value = p.value;
    if (typeof path !== 'string' || typeof value !== 'string') {
      throw new Error(`Rule '${rule.id}': pattern.path and pattern.value must be strings`);
    }
    if (typeof op !== 'string' || !(VALID_OPS as readonly string[]).includes(op)) {
      throw new Error(
        `Rule '${rule.id}': pattern.op must be one of ${JSON.stringify(VALID_OPS)}, got '${String(op)}'`,
      );
    }
    const target = resolvePath(receipt, path);
    if (matchOne(op, value, target)) {
      matches.push([path, value]);
    }
  }

  const fired = mode === 'any' ? matches.length > 0 : matches.length === patterns.length;
  if (fired) {
    const [path, value] = matches[0]!;
    return {
      fired: true,
      reason: `ARGS_PATTERN_MATCH: pattern at ${path} matched value ${pyRepr(value)} (mode=${mode}, matched=${matches.length}/${patterns.length})`,
    };
  }
  return { fired: false, reason: '' };
}

export function evalPostStateAssertion(
  rule: Rule,
  receipt: Record<string, unknown>,
  _ctx: EvalContext,
): RuleResult {
  const field =
    (rule.parameters.field as string | undefined) ??
    'action_context.ors.commitments.post_state_hash';
  const expected = rule.parameters.expected_hash;
  const appliesTo = (rule.parameters.applies_to as string | undefined) ?? 'post_action_only';
  if (appliesTo !== 'post_action_only' && appliesTo !== 'always') {
    throw new Error(
      `Rule '${rule.id}': applies_to must be 'post_action_only' or 'always', got '${appliesTo}'`,
    );
  }
  if (expected !== undefined && expected !== null && typeof expected !== 'string') {
    throw new Error(`Rule '${rule.id}': expected_hash must be a string or absent`);
  }
  if (typeof field !== 'string') {
    throw new Error(`Rule '${rule.id}': field must be a string`);
  }

  const actual = resolvePath(receipt, field);
  if (actual === null || actual === undefined) {
    if (appliesTo === 'post_action_only') return { fired: false, reason: '' };
    return {
      fired: true,
      reason: `POST_STATE_ASSERTION: ${field} absent on receipt`,
    };
  }
  if (expected === undefined || expected === null) return { fired: false, reason: '' };
  if (actual !== expected) {
    return {
      fired: true,
      reason: `POST_STATE_ASSERTION: ${field} ${pyRepr(actual)} does not equal expected ${pyRepr(expected)}`,
    };
  }
  return { fired: false, reason: '' };
}

export type RuleEvaluator = (
  rule: Rule,
  receipt: Record<string, unknown>,
  ctx: EvalContext,
) => RuleResult;

export const DISPATCH: Record<string, RuleEvaluator> = {
  max_amount: evalMaxAmount,
  daily_limit: evalDailyLimit,
  action_type_allowlist: evalActionTypeAllowlist,
  action_type_denylist: evalActionTypeDenylist,
  url_prefix_allowlist: evalUrlPrefixAllowlist,
  url_prefix_denylist: evalUrlPrefixDenylist,
  escalation_threshold: evalEscalationThreshold,
  tool_id_allowlist: evalToolIdAllowlist,
  args_pattern_match: evalArgsPatternMatch,
  post_state_assertion: evalPostStateAssertion,
};

// Monotonic clock in seconds — JS equivalent of Python's time.monotonic().
// performance.now() returns ms since process start, monotonically increasing.
export function monotonicSeconds(): number {
  return performance.now() / 1000;
}
