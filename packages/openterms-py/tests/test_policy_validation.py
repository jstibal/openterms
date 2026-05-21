"""Validation / error-path tests for the policy engine.

Each evaluator raises ``ValueError`` for malformed parameters or receipts. The
engine is the spec for what is and is not a valid rule; these tests pin that
spec. Parameter validation runs at evaluation time (not at policy parse time)
to keep the public ``Rule.from_dict`` surface minimal — only structural
validation lives there.
"""

from __future__ import annotations

from typing import Any

import pytest

from openterms.policy.engine import evaluate
from openterms.policy.pattern import VALID_OPS, match_one, resolve_path
from openterms.policy.rules import DISPATCH
from openterms.policy.types import EvalContext, Policy, Rule


def _evaluate_rule(rule_dict: dict[str, Any], receipt: dict[str, Any]) -> Any:
    rule = Rule.from_dict(rule_dict)
    return DISPATCH[rule.type](rule, receipt, EvalContext())


# ---------- Rule / Policy structural validation ----------


def test_rule_missing_required_field() -> None:
    with pytest.raises(ValueError, match="missing required field"):
        Rule.from_dict({"id": "r", "type": "max_amount", "outcome": "deny"})


def test_rule_parameters_must_be_object() -> None:
    with pytest.raises(ValueError, match="parameters must be an object"):
        Rule.from_dict(
            {"id": "r", "type": "max_amount", "outcome": "deny", "parameters": []}
        )


def test_policy_rules_must_be_list() -> None:
    with pytest.raises(ValueError, match="Policy.rules must be a list"):
        Policy.from_dict({"version": "v1", "rules": "not-a-list"})


# ---------- _require_int / _require_list / _amount ----------


def test_max_amount_missing_threshold() -> None:
    with pytest.raises(ValueError, match="missing 'threshold'"):
        _evaluate_rule(
            {"id": "r", "type": "max_amount", "outcome": "deny", "parameters": {}},
            {"amount_charged": 1},
        )


def test_max_amount_non_int_threshold() -> None:
    with pytest.raises(ValueError, match="must be an integer"):
        _evaluate_rule(
            {
                "id": "r",
                "type": "max_amount",
                "outcome": "deny",
                "parameters": {"threshold": "100"},
            },
            {"amount_charged": 1},
        )


def test_max_amount_bool_threshold_rejected() -> None:
    """bool is a subclass of int in Python; reject it explicitly."""
    with pytest.raises(ValueError, match="must be an integer"):
        _evaluate_rule(
            {
                "id": "r",
                "type": "max_amount",
                "outcome": "deny",
                "parameters": {"threshold": True},
            },
            {"amount_charged": 1},
        )


def test_receipt_amount_must_be_int() -> None:
    with pytest.raises(ValueError, match="amount_charged must be an integer"):
        _evaluate_rule(
            {
                "id": "r",
                "type": "max_amount",
                "outcome": "deny",
                "parameters": {"threshold": 100},
            },
            {"amount_charged": 1.5},
        )


def test_allowlist_missing_param() -> None:
    with pytest.raises(ValueError, match="missing 'allowed'"):
        _evaluate_rule(
            {
                "id": "r",
                "type": "action_type_allowlist",
                "outcome": "deny",
                "parameters": {},
            },
            {"action_type": "x"},
        )


def test_allowlist_wrong_param_type() -> None:
    with pytest.raises(ValueError, match="must be a list of strings"):
        _evaluate_rule(
            {
                "id": "r",
                "type": "action_type_allowlist",
                "outcome": "deny",
                "parameters": {"allowed": [1, 2]},
            },
            {"action_type": "x"},
        )


def test_daily_limit_unknown_window() -> None:
    with pytest.raises(ValueError, match="window must be one of"):
        _evaluate_rule(
            {
                "id": "dl",
                "type": "daily_limit",
                "outcome": "deny",
                "parameters": {"threshold": 100, "window": "lunar_day"},
            },
            {"amount_charged": 1},
        )


def test_daily_limit_aggregate_must_be_int() -> None:
    rule = Rule.from_dict(
        {
            "id": "dl",
            "type": "daily_limit",
            "outcome": "deny",
            "parameters": {"threshold": 100},
        }
    )
    ctx = EvalContext(aggregates={"dl": "900"})  # type: ignore[dict-item]
    with pytest.raises(ValueError, match="aggregate value"):
        DISPATCH["daily_limit"](rule, {"amount_charged": 50}, ctx)


# ---------- url_prefix source_field validation ----------


def test_url_prefix_source_field_must_be_string() -> None:
    with pytest.raises(ValueError, match="source_field must be a string"):
        _evaluate_rule(
            {
                "id": "u",
                "type": "url_prefix_allowlist",
                "outcome": "deny",
                "parameters": {"allowed": ["https://"], "source_field": 42},
            },
            {"terms_url": "https://x"},
        )


# ---------- args_pattern_match parameter validation ----------


def test_pattern_match_patterns_must_be_non_empty_list() -> None:
    with pytest.raises(ValueError, match="non-empty list"):
        _evaluate_rule(
            {
                "id": "apm",
                "type": "args_pattern_match",
                "outcome": "deny",
                "parameters": {"patterns": []},
            },
            {},
        )


def test_pattern_match_invalid_mode() -> None:
    with pytest.raises(ValueError, match="mode must be"):
        _evaluate_rule(
            {
                "id": "apm",
                "type": "args_pattern_match",
                "outcome": "deny",
                "parameters": {
                    "patterns": [{"path": "a", "op": "equals", "value": "x"}],
                    "mode": "some",
                },
            },
            {},
        )


def test_pattern_match_pattern_must_be_object() -> None:
    with pytest.raises(ValueError, match="each pattern must be an object"):
        _evaluate_rule(
            {
                "id": "apm",
                "type": "args_pattern_match",
                "outcome": "deny",
                "parameters": {"patterns": ["not-an-object"]},
            },
            {},
        )


def test_pattern_match_path_must_be_string() -> None:
    with pytest.raises(ValueError, match="path and pattern.value must be strings"):
        _evaluate_rule(
            {
                "id": "apm",
                "type": "args_pattern_match",
                "outcome": "deny",
                "parameters": {"patterns": [{"path": 1, "op": "equals", "value": "x"}]},
            },
            {},
        )


def test_pattern_match_invalid_op() -> None:
    with pytest.raises(ValueError, match="pattern.op must be one of"):
        _evaluate_rule(
            {
                "id": "apm",
                "type": "args_pattern_match",
                "outcome": "deny",
                "parameters": {
                    "patterns": [{"path": "a", "op": "regex", "value": "x"}]
                },
            },
            {},
        )


# ---------- post_state_assertion parameter validation ----------


def test_post_state_assertion_invalid_applies_to() -> None:
    with pytest.raises(ValueError, match="applies_to must be"):
        _evaluate_rule(
            {
                "id": "psa",
                "type": "post_state_assertion",
                "outcome": "deny",
                "parameters": {"applies_to": "maybe"},
            },
            {"action_context": {}},
        )


def test_post_state_assertion_expected_hash_wrong_type() -> None:
    with pytest.raises(ValueError, match="expected_hash must be a string"):
        _evaluate_rule(
            {
                "id": "psa",
                "type": "post_state_assertion",
                "outcome": "deny",
                "parameters": {"expected_hash": 123},
            },
            {"action_context": {}},
        )


def test_post_state_assertion_field_wrong_type() -> None:
    with pytest.raises(ValueError, match="field must be a string"):
        _evaluate_rule(
            {
                "id": "psa",
                "type": "post_state_assertion",
                "outcome": "deny",
                "parameters": {"field": 99},
            },
            {"action_context": {}},
        )


def test_post_state_assertion_always_match_does_not_fire() -> None:
    res = _evaluate_rule(
        {
            "id": "psa",
            "type": "post_state_assertion",
            "outcome": "deny",
            "parameters": {"applies_to": "always", "expected_hash": "a" * 64},
        },
        {"action_context": {"ors": {"commitments": {"post_state_hash": "a" * 64}}}},
    )
    assert not res.fired


def test_post_state_assertion_always_present_without_expected_does_not_fire() -> None:
    res = _evaluate_rule(
        {
            "id": "psa",
            "type": "post_state_assertion",
            "outcome": "deny",
            "parameters": {"applies_to": "always"},
        },
        {"action_context": {"ors": {"commitments": {"post_state_hash": "x" * 64}}}},
    )
    assert not res.fired


# ---------- policy_pattern primitives ----------


def test_resolve_path_empty_returns_none() -> None:
    assert resolve_path({"a": 1}, "") is None


def test_resolve_path_through_non_dict_returns_none() -> None:
    assert resolve_path({"a": [1, 2, 3]}, "a.0") is None


def test_match_one_unknown_op_raises() -> None:
    with pytest.raises(ValueError, match="Unknown pattern operator"):
        match_one("regex", "x", "y")


def test_match_one_target_none_returns_false() -> None:
    for op in VALID_OPS:
        assert match_one(op, "x", None) is False


def test_match_one_prefix_suffix_contains_positive() -> None:
    assert match_one("prefix", "abc", "abcdef") is True
    assert match_one("suffix", "def", "abcdef") is True
    assert match_one("contains", "cde", "abcdef") is True


def test_match_one_prefix_suffix_contains_negative() -> None:
    assert match_one("prefix", "xyz", "abcdef") is False
    assert match_one("suffix", "xyz", "abcdef") is False
    assert match_one("contains", "xyz", "abcdef") is False


def test_match_one_coerces_non_string_target() -> None:
    assert match_one("equals", "42", 42) is True


def test_glob_matches_trailing_star() -> None:
    assert match_one("glob", "ssn-*", "ssn-1234") is True


def test_glob_with_question_mark() -> None:
    assert match_one("glob", "a?c", "abc") is True
    assert match_one("glob", "a?c", "abbc") is False


def test_glob_no_match_falls_through() -> None:
    """Exercise the ``return False`` path: no star, characters disagree."""
    assert match_one("glob", "abc", "abd") is False


def test_glob_backtrack_after_star() -> None:
    """Force the matcher's star-backtrack branch by failing then retrying."""
    assert match_one("glob", "*xyz", "axbxyz") is True


def test_glob_only_stars_matches_empty() -> None:
    assert match_one("glob", "***", "") is True
    assert match_one("glob", "**", "anything") is True


# ---------- evaluate-time wiring ----------


def test_pattern_loop_deadline_check_triggers_inside_evaluator() -> None:
    """Direct invocation of ``eval_args_pattern_match`` with an expired deadline
    exercises the per-pattern deadline check (the orchestrator's pre-rule check
    is bypassed because we are not going through ``evaluate``).
    """
    from openterms.policy.rules import eval_args_pattern_match
    from openterms.policy.types import PolicyTimeout

    rule = Rule.from_dict(
        {
            "id": "apm",
            "type": "args_pattern_match",
            "outcome": "deny",
            "parameters": {
                "patterns": [
                    {"path": "a", "op": "equals", "value": "x"},
                    {"path": "b", "op": "equals", "value": "y"},
                ]
            },
        }
    )
    ctx = EvalContext(deadline_monotonic=0.0)
    with pytest.raises(PolicyTimeout):
        eval_args_pattern_match(rule, {"a": "x", "b": "y"}, ctx)


def test_evaluated_at_fallback_when_receipt_has_neither_timestamp_field() -> None:
    """A bare-fragment receipt with no created_at and no timestamp falls back
    to the epoch sentinel. Production receipts always carry both per
    ``apps/api/src/routes/receipts.ts`` ingest validation; this path exists
    for tests."""
    d = evaluate({"amount_charged": 0, "action_type": "x"}, {"version": "v", "rules": []})
    assert d.evaluated_at == "1970-01-01T00:00:00Z"


def test_evaluate_propagates_validation_errors() -> None:
    """Parameter errors surface from evaluate() (they're not swallowed)."""
    with pytest.raises(ValueError, match="missing 'threshold'"):
        evaluate(
            {"amount_charged": 1, "created_at": "2026-05-20T00:00:00Z"},
            {
                "version": "v1",
                "rules": [
                    {
                        "id": "r",
                        "type": "max_amount",
                        "outcome": "deny",
                        "parameters": {},
                    }
                ],
            },
        )
