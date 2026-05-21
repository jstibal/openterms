"""Integration tests for the deterministic policy engine.

Covers:
  * Precedence: deny > escalate > allow, with all fired rules still recorded.
  * Empty policy returns allow with no triggered rules.
  * Timeout: a deadline already in the past produces a deny + TIMEOUT reason.
  * daily_limit aggregate snapshot integration.
  * Determinism harness: evaluating the same (policy, receipt) twice produces
    a byte-identical Decision (asserted via canonical JSON encoding).
  * Fixture tuples loaded from ``tests/fixtures/policy/*.json``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from openterms.policy.engine import DEFAULT_BUDGET_SECONDS, evaluate, evaluate_with_context
from openterms.policy.types import EvalContext, Policy, Rule

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "policy"

BASE_RECEIPT: dict[str, Any] = {
    "workspace_id": "11111111-1111-4111-8111-111111111111",
    "agent_id": "agent-a",
    "action_type": "api_call",
    "terms_url": "https://acme.com/terms",
    "terms_hash": "f" * 64,
    "timestamp": "2026-05-20T00:00:00Z",
    "pricing_version": "v1",
    "receipt_id": "22222222-2222-4222-8222-222222222222",
    "amount_charged": 100,
    "created_at": "2026-05-20T00:00:01Z",
}


def _receipt(**overrides: Any) -> dict[str, Any]:
    r = dict(BASE_RECEIPT)
    r.update(overrides)
    return r


def _eval(receipt: dict[str, Any], policy: Any, **kwargs: Any) -> Any:
    """Tests assert rule logic, not timing. Disable the per-evaluation budget
    by default so coverage instrumentation or a slow CI box cannot perturb the
    asserted decision. Tests that specifically exercise the timeout path use
    ``evaluate_with_context`` with an expired deadline instead.
    """
    kwargs.setdefault("budget_seconds", 0)
    return evaluate(receipt, policy, **kwargs)


def test_empty_policy_returns_allow() -> None:
    d = _eval(_receipt(), {"version": "v1", "rules": []}, budget_seconds=0)
    assert d.decision == "allow"
    assert d.triggered_rules == ()
    assert d.reasons == ()


def test_deny_beats_escalate_and_records_both() -> None:
    policy = {
        "version": "v2",
        "rules": [
            {
                "id": "esc",
                "type": "escalation_threshold",
                "outcome": "escalate",
                "parameters": {"threshold": 50},
            },
            {
                "id": "denybig",
                "type": "max_amount",
                "outcome": "deny",
                "parameters": {"threshold": 75},
            },
        ],
    }
    d = _eval(_receipt(amount_charged=200), policy)
    assert d.decision == "deny"
    assert set(d.triggered_rules) == {"esc", "denybig"}
    # Both reasons recorded for the audit trail.
    assert any("ESCALATION_THRESHOLD" in r for r in d.reasons)
    assert any("MAX_AMOUNT" in r for r in d.reasons)


def test_escalate_beats_allow_outcome_rule() -> None:
    """A rule with outcome=allow that fires is recorded but does not block escalate."""
    policy = {
        "version": "v3",
        "rules": [
            {
                "id": "allow_when_low",
                "type": "max_amount",
                "outcome": "allow",
                # fires when amount > 0; this models a "flag low-value purchases" rule
                "parameters": {"threshold": 0},
            },
            {
                "id": "esc",
                "type": "escalation_threshold",
                "outcome": "escalate",
                "parameters": {"threshold": 100},
            },
        ],
    }
    d = _eval(_receipt(amount_charged=150), policy)
    assert d.decision == "escalate"
    assert "allow_when_low" in d.triggered_rules
    assert "esc" in d.triggered_rules


def test_allow_outcome_rule_alone_keeps_decision_allow() -> None:
    """The default-allow path should not be perturbed when only allow-outcome rules fire."""
    policy = {
        "version": "v4",
        "rules": [
            {
                "id": "flag_low",
                "type": "max_amount",
                "outcome": "allow",
                "parameters": {"threshold": 0},
            }
        ],
    }
    d = _eval(_receipt(amount_charged=10), policy)
    assert d.decision == "allow"
    assert d.triggered_rules == ("flag_low",)


def test_timeout_returns_deny_and_records_timeout_reason() -> None:
    policy = {
        "version": "vT",
        "rules": [
            {
                "id": "m",
                "type": "max_amount",
                "outcome": "deny",
                "parameters": {"threshold": 0},
            }
        ],
    }
    # A deadline already in the past forces a TIMEOUT on the first deadline check.
    ctx = EvalContext(deadline_monotonic=0.0)
    d = evaluate_with_context(_receipt(amount_charged=1), policy, ctx)
    assert d.decision == "deny"
    assert any(r.startswith("TIMEOUT") for r in d.reasons)
    assert d.triggered_rules == ()


def test_args_pattern_match_timeout_inside_pattern_loop() -> None:
    """If the deadline trips during the pattern loop, we still get a deny+TIMEOUT."""
    policy = {
        "version": "vT2",
        "rules": [
            {
                "id": "apm",
                "type": "args_pattern_match",
                "outcome": "deny",
                "parameters": {
                    "patterns": [
                        {"path": "action_context.x", "op": "equals", "value": "1"},
                        {"path": "action_context.y", "op": "equals", "value": "2"},
                    ]
                },
            }
        ],
    }
    ctx = EvalContext(deadline_monotonic=0.0)
    d = evaluate_with_context(
        _receipt(action_context={"x": "1", "y": "2"}), policy, ctx
    )
    assert d.decision == "deny"
    assert any(r.startswith("TIMEOUT") for r in d.reasons)


def test_daily_limit_uses_caller_supplied_aggregate() -> None:
    policy = {
        "version": "vDL",
        "rules": [
            {
                "id": "dl",
                "type": "daily_limit",
                "outcome": "deny",
                "parameters": {"threshold": 1000, "window": "utc_day"},
            }
        ],
    }
    d_over = _eval(
        _receipt(amount_charged=200),
        policy,
        aggregates={"dl": 900},  # 900 + 200 = 1100 > 1000
    )
    d_under = _eval(
        _receipt(amount_charged=200),
        policy,
        aggregates={"dl": 500},  # 500 + 200 = 700 <= 1000
    )
    assert d_over.decision == "deny"
    assert d_under.decision == "allow"


def test_daily_limit_rejects_unknown_window() -> None:
    policy = {
        "version": "vDL2",
        "rules": [
            {
                "id": "dl",
                "type": "daily_limit",
                "outcome": "deny",
                "parameters": {"threshold": 100, "window": "calendar_day_local"},
            }
        ],
    }
    with pytest.raises(ValueError, match="window must be one of"):
        evaluate(_receipt(), policy)


def test_unknown_rule_type_rejected_at_parse_time() -> None:
    with pytest.raises(ValueError, match="Unknown rule type"):
        Rule.from_dict(
            {
                "id": "r",
                "type": "bogus_rule",
                "outcome": "deny",
                "parameters": {},
            }
        )


def test_invalid_outcome_rejected() -> None:
    with pytest.raises(ValueError, match="Invalid outcome"):
        Rule.from_dict(
            {"id": "r", "type": "max_amount", "outcome": "maybe", "parameters": {}}
        )


def test_policy_accepts_policy_instance() -> None:
    policy = Policy.from_dict(
        {
            "version": "p",
            "rules": [
                {
                    "id": "m",
                    "type": "max_amount",
                    "outcome": "deny",
                    "parameters": {"threshold": 0},
                }
            ],
        }
    )
    d = _eval(_receipt(amount_charged=10), policy)
    assert d.decision == "deny"


def test_policy_rejects_non_dict_non_policy() -> None:
    with pytest.raises(TypeError):
        evaluate(_receipt(), 42)  # type: ignore[arg-type]


def test_evaluated_at_override() -> None:
    d = _eval(
        _receipt(),
        {"version": "v1", "rules": []},
        evaluated_at="2099-01-01T00:00:00Z",
    )
    assert d.evaluated_at == "2099-01-01T00:00:00Z"


def test_evaluated_at_falls_back_to_timestamp_when_created_at_absent() -> None:
    r = dict(BASE_RECEIPT)
    del r["created_at"]
    d = _eval(r, {"version": "v1", "rules": []})
    assert d.evaluated_at == r["timestamp"]


def test_decision_to_dict_round_trip() -> None:
    d = _eval(_receipt(), {"version": "v1", "rules": []}, budget_seconds=0)
    out = d.to_dict()
    assert out["decision"] == "allow"
    assert out["triggered_rules"] == []
    assert out["reasons"] == []


def test_url_prefix_handles_missing_field_as_empty_string() -> None:
    """A receipt without ``terms_url`` should not crash; the prefix check fails."""
    r = dict(BASE_RECEIPT)
    del r["terms_url"]
    policy = {
        "version": "v",
        "rules": [
            {
                "id": "u",
                "type": "url_prefix_allowlist",
                "outcome": "deny",
                "parameters": {"allowed": ["https://acme.com/"]},
            }
        ],
    }
    d = _eval(r, policy)
    assert d.decision == "deny"


def test_budget_zero_disables_deadline_for_long_policies() -> None:
    """budget_seconds=0 disables the budget entirely; many rules still complete."""
    rules = [
        {
            "id": f"r{i}",
            "type": "max_amount",
            "outcome": "deny",
            "parameters": {"threshold": 10_000_000},
        }
        for i in range(200)
    ]
    d = _eval(_receipt(amount_charged=1), {"version": "v", "rules": rules}, budget_seconds=0)
    assert d.decision == "allow"


def test_determinism_byte_equal_decisions() -> None:
    """Twin evaluations of the same input produce byte-identical Decision JSON."""
    policy = {
        "version": "vDet",
        "rules": [
            {
                "id": "esc",
                "type": "escalation_threshold",
                "outcome": "escalate",
                "parameters": {"threshold": 50},
            },
            {
                "id": "deny",
                "type": "max_amount",
                "outcome": "deny",
                "parameters": {"threshold": 75},
            },
            {
                "id": "u",
                "type": "url_prefix_denylist",
                "outcome": "deny",
                "parameters": {"denied": ["https://evil.example/"]},
            },
        ],
    }
    r = _receipt(amount_charged=200, terms_url="https://evil.example/x")
    d1 = _eval(r, policy)
    d2 = _eval(r, policy)
    def _enc(d: Any) -> str:
        return json.dumps(d.to_dict(), sort_keys=True, separators=(",", ":"))

    assert _enc(d1) == _enc(d2)
    # The 5 ms budget had better not affect this small policy.
    assert d1.decision == "deny"
    assert "esc" in d1.triggered_rules and "deny" in d1.triggered_rules
    # Sanity: default budget is reachable in the public surface.
    assert DEFAULT_BUDGET_SECONDS == 0.005


# ---------- Fixture-driven cross-language parity tuples ----------


def _load_fixtures() -> list[tuple[str, dict[str, Any]]]:
    cases: list[tuple[str, dict[str, Any]]] = []
    for path in sorted(FIXTURES_DIR.glob("*.json")):
        with path.open(encoding="utf-8") as f:
            cases.append((path.name, json.load(f)))
    return cases


FIXTURES = _load_fixtures()


@pytest.mark.parametrize("name,case", FIXTURES, ids=[n for n, _ in FIXTURES])
def test_fixture_tuple(name: str, case: dict[str, Any]) -> None:
    """Each fixture: ``{policy, receipt, aggregates?, force_timeout?, expected}``."""
    expected = case["expected"]
    if case.get("force_timeout"):
        ctx = EvalContext(
            aggregates=dict(case.get("aggregates", {})),
            deadline_monotonic=0.0,
        )
        d = evaluate_with_context(case["receipt"], case["policy"], ctx)
    else:
        d = _eval(
            case["receipt"],
            case["policy"],
            aggregates=case.get("aggregates"),
        )
    assert d.decision == expected["decision"], name
    assert list(d.triggered_rules) == expected["triggered_rules"], name
    # Reasons: the fixture lists substrings each reason must contain, indexed
    # by position. This keeps fixtures stable against minor wording changes
    # while still pinning the structured prefix.
    expected_reasons = expected["reasons"]
    assert len(d.reasons) == len(expected_reasons), (name, d.reasons)
    for actual, needle in zip(d.reasons, expected_reasons, strict=True):
        assert needle in actual, (name, needle, actual)


def test_fixture_count_meets_session_minimum() -> None:
    """Session acceptance: 14 fixture tuples."""
    assert len(FIXTURES) >= 14
