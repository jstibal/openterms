"""Per-rule unit tests for the deterministic policy engine.

One positive (rule fires) and one negative (rule does not fire) test for each
of the ten rule types in build brief Section 8 Step 4. Each test constructs a
minimal receipt — the engine does not require a full ORS envelope to evaluate
rules, only the specific fields the rule type touches.

Parameter-validation errors (missing keys, wrong types, unsupported window
values) are exercised in ``test_policy_validation.py`` so this file stays
focused on the firing/no-firing semantics of each rule.
"""

from __future__ import annotations

from typing import Any

from openterms.policy import evaluate
from openterms.policy_rules import DISPATCH
from openterms.policy_types import EvalContext, Rule


def _run(rule_dict: dict[str, Any], receipt: dict[str, Any], **kwargs: Any) -> Any:
    rule = Rule.from_dict(rule_dict)
    ctx = EvalContext(
        aggregates=dict(kwargs.get("aggregates", {})),
        deadline_monotonic=None,
    )
    return DISPATCH[rule.type](rule, receipt, ctx)


# ---------- max_amount ----------


def test_max_amount_fires_when_over_threshold() -> None:
    res = _run(
        {"id": "r", "type": "max_amount", "outcome": "deny", "parameters": {"threshold": 100}},
        {"amount_charged": 250},
    )
    assert res.fired
    assert "MAX_AMOUNT" in res.reason
    assert "250" in res.reason and "100" in res.reason


def test_max_amount_does_not_fire_at_threshold() -> None:
    res = _run(
        {"id": "r", "type": "max_amount", "outcome": "deny", "parameters": {"threshold": 100}},
        {"amount_charged": 100},
    )
    assert not res.fired


# ---------- daily_limit ----------


def test_daily_limit_fires_when_window_total_exceeded() -> None:
    res = _run(
        {
            "id": "dl",
            "type": "daily_limit",
            "outcome": "deny",
            "parameters": {"threshold": 1000, "window": "utc_day"},
        },
        {"amount_charged": 200},
        aggregates={"dl": 900},
    )
    assert res.fired
    assert "DAILY_LIMIT" in res.reason and "1100" in res.reason


def test_daily_limit_does_not_fire_within_window() -> None:
    res = _run(
        {
            "id": "dl",
            "type": "daily_limit",
            "outcome": "deny",
            "parameters": {"threshold": 1000},  # default window utc_day
        },
        {"amount_charged": 100},
        aggregates={"dl": 500},
    )
    assert not res.fired


# ---------- action_type_allowlist ----------


def test_action_type_allowlist_fires_on_non_allowed_type() -> None:
    res = _run(
        {
            "id": "ata",
            "type": "action_type_allowlist",
            "outcome": "deny",
            "parameters": {"allowed": ["api_call", "data_access"]},
        },
        {"action_type": "purchase"},
    )
    assert res.fired
    assert "ACTION_TYPE_ALLOWLIST" in res.reason


def test_action_type_allowlist_does_not_fire_when_allowed() -> None:
    res = _run(
        {
            "id": "ata",
            "type": "action_type_allowlist",
            "outcome": "deny",
            "parameters": {"allowed": ["api_call"]},
        },
        {"action_type": "api_call"},
    )
    assert not res.fired


# ---------- action_type_denylist ----------


def test_action_type_denylist_fires_when_denied() -> None:
    res = _run(
        {
            "id": "atd",
            "type": "action_type_denylist",
            "outcome": "deny",
            "parameters": {"denied": ["purchase"]},
        },
        {"action_type": "purchase"},
    )
    assert res.fired


def test_action_type_denylist_does_not_fire_when_not_denied() -> None:
    res = _run(
        {
            "id": "atd",
            "type": "action_type_denylist",
            "outcome": "deny",
            "parameters": {"denied": ["purchase"]},
        },
        {"action_type": "api_call"},
    )
    assert not res.fired


# ---------- url_prefix_allowlist ----------


def test_url_prefix_allowlist_fires_when_no_prefix_matches() -> None:
    res = _run(
        {
            "id": "ua",
            "type": "url_prefix_allowlist",
            "outcome": "deny",
            "parameters": {"allowed": ["https://acme.com/"]},
        },
        {"terms_url": "https://evil.example/"},
    )
    assert res.fired


def test_url_prefix_allowlist_does_not_fire_on_match() -> None:
    res = _run(
        {
            "id": "ua",
            "type": "url_prefix_allowlist",
            "outcome": "deny",
            "parameters": {"allowed": ["https://acme.com/"]},
        },
        {"terms_url": "https://acme.com/terms"},
    )
    assert not res.fired


# ---------- url_prefix_denylist ----------


def test_url_prefix_denylist_fires_on_denied_prefix() -> None:
    res = _run(
        {
            "id": "ud",
            "type": "url_prefix_denylist",
            "outcome": "deny",
            "parameters": {"denied": ["https://evil.example/"]},
        },
        {"terms_url": "https://evil.example/x"},
    )
    assert res.fired


def test_url_prefix_denylist_does_not_fire_without_match() -> None:
    res = _run(
        {
            "id": "ud",
            "type": "url_prefix_denylist",
            "outcome": "deny",
            "parameters": {"denied": ["https://evil.example/"]},
        },
        {"terms_url": "https://acme.com/x"},
    )
    assert not res.fired


# ---------- escalation_threshold ----------


def test_escalation_threshold_fires_at_inclusive_boundary() -> None:
    res = _run(
        {
            "id": "esc",
            "type": "escalation_threshold",
            "outcome": "escalate",
            "parameters": {"threshold": 1000},
        },
        {"amount_charged": 1000},
    )
    assert res.fired
    assert "meets escalation threshold 1000" in res.reason


def test_escalation_threshold_does_not_fire_below() -> None:
    res = _run(
        {
            "id": "esc",
            "type": "escalation_threshold",
            "outcome": "escalate",
            "parameters": {"threshold": 1000},
        },
        {"amount_charged": 999},
    )
    assert not res.fired


# ---------- tool_id_allowlist ----------


def test_tool_id_allowlist_fires_when_tool_id_missing() -> None:
    res = _run(
        {
            "id": "tia",
            "type": "tool_id_allowlist",
            "outcome": "deny",
            "parameters": {"allowed": ["safe.read"]},
        },
        {"action_context": {}},
    )
    assert res.fired
    assert "absent" in res.reason


def test_tool_id_allowlist_does_not_fire_when_allowed() -> None:
    res = _run(
        {
            "id": "tia",
            "type": "tool_id_allowlist",
            "outcome": "deny",
            "parameters": {"allowed": ["safe.read"]},
        },
        {"action_context": {"ors": {"commitments": {"tool_id": "safe.read"}}}},
    )
    assert not res.fired


def test_tool_id_allowlist_fires_when_tool_id_not_in_list() -> None:
    res = _run(
        {
            "id": "tia",
            "type": "tool_id_allowlist",
            "outcome": "deny",
            "parameters": {"allowed": ["safe.read"]},
        },
        {"action_context": {"ors": {"commitments": {"tool_id": "internal.fetch"}}}},
    )
    assert res.fired
    assert "internal.fetch" in res.reason


# ---------- args_pattern_match ----------


def test_args_pattern_match_fires_on_glob_match() -> None:
    res = _run(
        {
            "id": "apm",
            "type": "args_pattern_match",
            "outcome": "deny",
            "parameters": {
                "patterns": [
                    {"path": "action_context.target", "op": "glob", "value": "ssn-*"}
                ],
                "mode": "any",
            },
        },
        {"action_context": {"target": "ssn-1234"}},
    )
    assert res.fired
    assert "ARGS_PATTERN_MATCH" in res.reason


def test_args_pattern_match_does_not_fire_when_target_absent() -> None:
    res = _run(
        {
            "id": "apm",
            "type": "args_pattern_match",
            "outcome": "deny",
            "parameters": {
                "patterns": [
                    {"path": "action_context.target", "op": "equals", "value": "x"}
                ],
            },
        },
        {"action_context": {}},
    )
    assert not res.fired


def test_args_pattern_match_all_mode_requires_every_pattern() -> None:
    rule = {
        "id": "apm",
        "type": "args_pattern_match",
        "outcome": "deny",
        "parameters": {
            "patterns": [
                {"path": "action_context.a", "op": "equals", "value": "1"},
                {"path": "action_context.b", "op": "equals", "value": "2"},
            ],
            "mode": "all",
        },
    }
    fired = _run(rule, {"action_context": {"a": "1", "b": "2"}})
    not_fired = _run(rule, {"action_context": {"a": "1", "b": "3"}})
    assert fired.fired and not not_fired.fired


# ---------- post_state_assertion ----------


def test_post_state_assertion_post_action_only_skips_pre_action_receipt() -> None:
    res = _run(
        {
            "id": "psa",
            "type": "post_state_assertion",
            "outcome": "deny",
            "parameters": {"expected_hash": "a" * 64},
        },
        {"action_context": {}},
    )
    assert not res.fired


def test_post_state_assertion_fires_on_mismatch() -> None:
    res = _run(
        {
            "id": "psa",
            "type": "post_state_assertion",
            "outcome": "deny",
            "parameters": {"expected_hash": "a" * 64},
        },
        {
            "action_context": {
                "ors": {"commitments": {"post_state_hash": "b" * 64}}
            }
        },
    )
    assert res.fired
    assert "does not equal" in res.reason


def test_post_state_assertion_always_fires_when_field_absent() -> None:
    res = _run(
        {
            "id": "psa",
            "type": "post_state_assertion",
            "outcome": "deny",
            "parameters": {"applies_to": "always"},
        },
        {"action_context": {}},
    )
    assert res.fired
    assert "absent" in res.reason


def test_post_state_assertion_match_does_not_fire() -> None:
    res = _run(
        {
            "id": "psa",
            "type": "post_state_assertion",
            "outcome": "deny",
            "parameters": {"expected_hash": "a" * 64},
        },
        {
            "action_context": {"ors": {"commitments": {"post_state_hash": "a" * 64}}}
        },
    )
    assert not res.fired


# ---------- single-rule evaluate smoke ----------


def test_single_rule_allow_when_nothing_fires() -> None:
    decision = evaluate(
        {"amount_charged": 50, "action_type": "api_call", "created_at": "2026-05-20T00:00:00Z"},
        {
            "version": "v1",
            "rules": [
                {
                    "id": "r",
                    "type": "max_amount",
                    "outcome": "deny",
                    "parameters": {"threshold": 100},
                }
            ],
        },
    )
    assert decision.decision == "allow"
    assert decision.triggered_rules == ()
    assert decision.reasons == ()
    assert decision.policy_version == "v1"
    assert decision.evaluated_at == "2026-05-20T00:00:00Z"
