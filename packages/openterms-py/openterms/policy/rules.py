"""Per-rule evaluators for the OpenTerms policy engine.

Each evaluator is a pure function ``(rule, receipt, ctx) -> RuleResult``. They
never call the clock, never do I/O, never call out to a model, and never use
unconstrained regex. The orchestrator in :mod:`openterms.policy` iterates over
the rules in declared order, collects the fired ones, and applies the
``deny > escalate > allow`` precedence.

Reason format is locked at ``<RULE_TYPE_UPPER>: <action phrase with values>``
so dashboards can group by prefix and so a non-technical reviewer can read the
audit trail without consulting the rule schema. See the build brief Section 8
Step 4 and the session proposal for the full rationale.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from .pattern import VALID_OPS, match_one, resolve_path
from .types import EvalContext, PolicyTimeout, Rule, RuleResult

_VALID_DAILY_WINDOWS = ("utc_day", "rolling_24h")


def _require_int(params: dict[str, Any], key: str, rule_id: str) -> int:
    if key not in params:
        raise ValueError(f"Rule {rule_id!r} parameters missing '{key}'")
    val = params[key]
    if not isinstance(val, int) or isinstance(val, bool):
        raise ValueError(f"Rule {rule_id!r} parameter {key!r} must be an integer")
    return val


def _require_list(params: dict[str, Any], key: str, rule_id: str) -> list[str]:
    if key not in params:
        raise ValueError(f"Rule {rule_id!r} parameters missing '{key}'")
    val = params[key]
    if not isinstance(val, list) or not all(isinstance(v, str) for v in val):
        raise ValueError(f"Rule {rule_id!r} parameter {key!r} must be a list of strings")
    return val


def _amount(receipt: dict[str, Any], rule_id: str) -> int:
    val = receipt.get("amount_charged")
    if not isinstance(val, int) or isinstance(val, bool):
        raise ValueError(
            f"Rule {rule_id!r}: receipt.amount_charged must be an integer (ORS minor units)"
        )
    return val


def eval_max_amount(rule: Rule, receipt: dict[str, Any], _ctx: EvalContext) -> RuleResult:
    threshold = _require_int(rule.parameters, "threshold", rule.id)
    amount = _amount(receipt, rule.id)
    if amount > threshold:
        return RuleResult(
            fired=True,
            reason=f"MAX_AMOUNT: amount_charged {amount} exceeds threshold {threshold}",
        )
    return RuleResult(fired=False)


def eval_daily_limit(rule: Rule, receipt: dict[str, Any], ctx: EvalContext) -> RuleResult:
    threshold = _require_int(rule.parameters, "threshold", rule.id)
    window = rule.parameters.get("window", "utc_day")
    if window not in _VALID_DAILY_WINDOWS:
        raise ValueError(
            f"Rule {rule.id!r}: window must be one of {_VALID_DAILY_WINDOWS}, got {window!r}"
        )
    prior_total = ctx.aggregates.get(rule.id, 0)
    if not isinstance(prior_total, int) or isinstance(prior_total, bool):
        raise ValueError(
            f"Rule {rule.id!r}: aggregate value for this rule must be an integer"
        )
    total = prior_total + _amount(receipt, rule.id)
    if total > threshold:
        return RuleResult(
            fired=True,
            reason=(
                f"DAILY_LIMIT: cumulative amount {total} in window {window} "
                f"exceeds threshold {threshold}"
            ),
        )
    return RuleResult(fired=False)


def eval_action_type_allowlist(
    rule: Rule, receipt: dict[str, Any], _ctx: EvalContext
) -> RuleResult:
    allowed = _require_list(rule.parameters, "allowed", rule.id)
    action_type = receipt.get("action_type")
    if action_type not in allowed:
        return RuleResult(
            fired=True,
            reason=(
                f"ACTION_TYPE_ALLOWLIST: action_type {action_type!r} is not on the allow list"
            ),
        )
    return RuleResult(fired=False)


def eval_action_type_denylist(
    rule: Rule, receipt: dict[str, Any], _ctx: EvalContext
) -> RuleResult:
    denied = _require_list(rule.parameters, "denied", rule.id)
    action_type = receipt.get("action_type")
    if action_type in denied:
        return RuleResult(
            fired=True,
            reason=f"ACTION_TYPE_DENYLIST: action_type {action_type!r} is on the deny list",
        )
    return RuleResult(fired=False)


def _url_source(rule: Rule, receipt: dict[str, Any]) -> tuple[str, Any]:
    source_field = rule.parameters.get("source_field", "terms_url")
    if not isinstance(source_field, str):
        raise ValueError(f"Rule {rule.id!r}: source_field must be a string")
    return source_field, resolve_path(receipt, source_field)


def eval_url_prefix_allowlist(
    rule: Rule, receipt: dict[str, Any], _ctx: EvalContext
) -> RuleResult:
    allowed = _require_list(rule.parameters, "allowed", rule.id)
    field, value = _url_source(rule, receipt)
    text = value if isinstance(value, str) else ""
    if not any(text.startswith(prefix) for prefix in allowed):
        return RuleResult(
            fired=True,
            reason=(
                f"URL_PREFIX_ALLOWLIST: {field} {text!r} does not match any allowed prefix"
            ),
        )
    return RuleResult(fired=False)


def eval_url_prefix_denylist(
    rule: Rule, receipt: dict[str, Any], _ctx: EvalContext
) -> RuleResult:
    denied = _require_list(rule.parameters, "denied", rule.id)
    field, value = _url_source(rule, receipt)
    text = value if isinstance(value, str) else ""
    for prefix in denied:
        if text.startswith(prefix):
            return RuleResult(
                fired=True,
                reason=(
                    f"URL_PREFIX_DENYLIST: {field} {text!r} starts with denied prefix {prefix!r}"
                ),
            )
    return RuleResult(fired=False)


def eval_escalation_threshold(
    rule: Rule, receipt: dict[str, Any], _ctx: EvalContext
) -> RuleResult:
    threshold = _require_int(rule.parameters, "threshold", rule.id)
    amount = _amount(receipt, rule.id)
    if amount >= threshold:
        return RuleResult(
            fired=True,
            reason=(
                f"ESCALATION_THRESHOLD: amount_charged {amount} "
                f"meets escalation threshold {threshold}"
            ),
        )
    return RuleResult(fired=False)


def eval_tool_id_allowlist(
    rule: Rule, receipt: dict[str, Any], _ctx: EvalContext
) -> RuleResult:
    allowed = _require_list(rule.parameters, "allowed", rule.id)
    tool_id = resolve_path(receipt, "action_context.ors.commitments.tool_id")
    if tool_id is None:
        return RuleResult(
            fired=True,
            reason="TOOL_ID_ALLOWLIST: tool_id absent from receipt commitments",
        )
    if tool_id not in allowed:
        return RuleResult(
            fired=True,
            reason=f"TOOL_ID_ALLOWLIST: tool_id {tool_id!r} is not in the allow list",
        )
    return RuleResult(fired=False)


def eval_args_pattern_match(
    rule: Rule, receipt: dict[str, Any], ctx: EvalContext
) -> RuleResult:
    patterns = rule.parameters.get("patterns")
    if not isinstance(patterns, list) or not patterns:
        raise ValueError(
            f"Rule {rule.id!r}: parameters.patterns must be a non-empty list"
        )
    mode = rule.parameters.get("mode", "any")
    if mode not in ("any", "all"):
        raise ValueError(f"Rule {rule.id!r}: mode must be 'any' or 'all', got {mode!r}")

    matches: list[tuple[str, str]] = []
    for pat in patterns:
        if ctx.deadline_monotonic is not None and time.monotonic() > ctx.deadline_monotonic:
            raise PolicyTimeout()
        if not isinstance(pat, dict):
            raise ValueError(f"Rule {rule.id!r}: each pattern must be an object")
        path = pat.get("path")
        op = pat.get("op")
        value = pat.get("value")
        if not isinstance(path, str) or not isinstance(value, str):
            raise ValueError(
                f"Rule {rule.id!r}: pattern.path and pattern.value must be strings"
            )
        if op not in VALID_OPS:
            raise ValueError(
                f"Rule {rule.id!r}: pattern.op must be one of {VALID_OPS}, got {op!r}"
            )
        target = resolve_path(receipt, path)
        if match_one(op, value, target):
            matches.append((path, value))

    fired = bool(matches) if mode == "any" else (len(matches) == len(patterns))
    if fired:
        path, value = matches[0]
        return RuleResult(
            fired=True,
            reason=(
                f"ARGS_PATTERN_MATCH: pattern at {path} matched value {value!r} "
                f"(mode={mode}, matched={len(matches)}/{len(patterns)})"
            ),
        )
    return RuleResult(fired=False)


def eval_post_state_assertion(
    rule: Rule, receipt: dict[str, Any], _ctx: EvalContext
) -> RuleResult:
    field = rule.parameters.get(
        "field", "action_context.ors.commitments.post_state_hash"
    )
    expected = rule.parameters.get("expected_hash")
    applies_to = rule.parameters.get("applies_to", "post_action_only")
    if applies_to not in ("post_action_only", "always"):
        raise ValueError(
            f"Rule {rule.id!r}: applies_to must be 'post_action_only' or 'always', "
            f"got {applies_to!r}"
        )
    if expected is not None and not isinstance(expected, str):
        raise ValueError(f"Rule {rule.id!r}: expected_hash must be a string or absent")
    if not isinstance(field, str):
        raise ValueError(f"Rule {rule.id!r}: field must be a string")

    actual = resolve_path(receipt, field)
    if actual is None:
        if applies_to == "post_action_only":
            return RuleResult(fired=False)
        return RuleResult(
            fired=True,
            reason=f"POST_STATE_ASSERTION: {field} absent on receipt",
        )
    if expected is None:
        return RuleResult(fired=False)
    if actual != expected:
        return RuleResult(
            fired=True,
            reason=(
                f"POST_STATE_ASSERTION: {field} {actual!r} does not equal "
                f"expected {expected!r}"
            ),
        )
    return RuleResult(fired=False)


RuleEvaluator = Callable[[Rule, dict[str, Any], EvalContext], RuleResult]

DISPATCH: dict[str, RuleEvaluator] = {
    "max_amount": eval_max_amount,
    "daily_limit": eval_daily_limit,
    "action_type_allowlist": eval_action_type_allowlist,
    "action_type_denylist": eval_action_type_denylist,
    "url_prefix_allowlist": eval_url_prefix_allowlist,
    "url_prefix_denylist": eval_url_prefix_denylist,
    "escalation_threshold": eval_escalation_threshold,
    "tool_id_allowlist": eval_tool_id_allowlist,
    "args_pattern_match": eval_args_pattern_match,
    "post_state_assertion": eval_post_state_assertion,
}
