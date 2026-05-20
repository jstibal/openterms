"""Deterministic policy engine for OpenTerms agent action receipts.

Public surface: :func:`evaluate`. Given a policy and a signed ORS receipt
(as a plain dict), returns a :class:`~openterms.policy_types.Decision` that
satisfies the build brief's correctness constraints:

* **Determinism.** Same ``(policy, receipt, aggregates)`` triple always
  produces a byte-identical ``Decision``. No clock reads except a monotonic
  deadline used purely for the timeout budget (which never affects the
  decision value, only whether evaluation completed in time). No I/O, no LLM,
  no randomness, no unconstrained regex. See ``policy_pattern.py``.
* **Precedence.** ``deny`` beats ``escalate`` beats ``allow``. When no rule
  fires, the default is ``allow``. Every fired rule's id and reason are
  recorded, even if its outcome is overridden by precedence — the audit trail
  must be complete.
* **Timeout.** A per-evaluation deadline (default 5 ms) is enforced via a
  monotonic clock. On timeout the decision is ``deny`` with a ``TIMEOUT``
  reason, per the build brief.

The engine takes pre-computed aggregates (e.g. running daily totals for the
``daily_limit`` rule) as a caller input rather than reading state itself. The
caller is responsible for computing those aggregates deterministically from
the append-only receipt log; the engine is pure given that snapshot.
"""

from __future__ import annotations

import time
from typing import Any

from .policy_rules import DISPATCH
from .policy_types import (
    Decision,
    DecisionOutcome,
    EvalContext,
    Policy,
    PolicyTimeout,
    Rule,
    RuleResult,
)

DEFAULT_BUDGET_SECONDS = 0.005  # 5 ms p99 per build brief Section 8 Step 4.

_PRECEDENCE: dict[DecisionOutcome, int] = {"allow": 0, "escalate": 1, "deny": 2}


def _coerce_policy(policy: Policy | dict[str, Any]) -> Policy:
    if isinstance(policy, Policy):
        return policy
    if isinstance(policy, dict):
        return Policy.from_dict(policy)
    raise TypeError("policy must be a Policy instance or a dict")


def _evaluated_at(receipt: dict[str, Any], ctx: EvalContext) -> str:
    if ctx.evaluated_at is not None:
        return ctx.evaluated_at
    for key in ("created_at", "timestamp"):
        val = receipt.get(key)
        if isinstance(val, str) and val:
            return val
    # Receipt without a timestamp would have failed ingest validation; this
    # fallback exists only for unit tests that pass minimal receipt fragments.
    return "1970-01-01T00:00:00Z"


def _apply_rule(rule: Rule, receipt: dict[str, Any], ctx: EvalContext) -> RuleResult:
    # Rule.from_dict guards rule.type against VALID_RULE_TYPES, which mirrors
    # the DISPATCH keys, so a KeyError here would indicate a registry drift bug
    # rather than user input.
    return DISPATCH[rule.type](rule, receipt, ctx)


def evaluate(
    receipt: dict[str, Any],
    policy: Policy | dict[str, Any],
    *,
    aggregates: dict[str, int] | None = None,
    budget_seconds: float = DEFAULT_BUDGET_SECONDS,
    evaluated_at: str | None = None,
) -> Decision:
    """Evaluate a receipt against a policy and return a Decision.

    ``aggregates`` maps rule IDs to pre-computed totals used by aggregate-
    sensitive rules (``daily_limit``). Defaults to empty.

    ``budget_seconds`` is the per-evaluation wall-time deadline. Passing
    ``0`` (or any non-positive value) disables the budget entirely — useful
    for tests that want to force a timeout (combine with ``budget_seconds=0``
    plus a sentinel deadline supplied through a custom context — see
    :func:`evaluate_with_context`).

    ``evaluated_at`` overrides the timestamp recorded on the Decision. By
    default the receipt's own ``created_at`` (or ``timestamp``) is used so the
    decision is reproducible from the receipt alone.
    """
    if budget_seconds > 0:
        deadline = time.monotonic() + budget_seconds
    else:
        deadline = None
    ctx = EvalContext(
        aggregates=dict(aggregates or {}),
        deadline_monotonic=deadline,
        evaluated_at=evaluated_at,
    )
    return evaluate_with_context(receipt, policy, ctx)


def evaluate_with_context(
    receipt: dict[str, Any],
    policy: Policy | dict[str, Any],
    ctx: EvalContext,
) -> Decision:
    """Evaluate using an explicit context.

    Tests use this entry point to inject a deadline already in the past
    (forcing a deterministic ``TIMEOUT`` deny) or to override the aggregate
    snapshot.
    """
    pol = _coerce_policy(policy)
    triggered: list[str] = []
    reasons: list[str] = []
    fired_outcomes: list[DecisionOutcome] = []

    try:
        for rule in pol.rules:
            if (
                ctx.deadline_monotonic is not None
                and time.monotonic() > ctx.deadline_monotonic
            ):
                raise PolicyTimeout()
            result = _apply_rule(rule, receipt, ctx)
            if result.fired:
                triggered.append(rule.id)
                reasons.append(result.reason)
                fired_outcomes.append(rule.outcome)
    except PolicyTimeout:
        reasons.append("TIMEOUT: rule evaluation exceeded the per-evaluation budget")
        return Decision(
            decision="deny",
            triggered_rules=tuple(triggered),
            reasons=tuple(reasons),
            policy_version=pol.version,
            evaluated_at=_evaluated_at(receipt, ctx),
        )

    if not fired_outcomes:
        final: DecisionOutcome = "allow"
    else:
        final = max(fired_outcomes, key=lambda o: _PRECEDENCE[o])

    return Decision(
        decision=final,
        triggered_rules=tuple(triggered),
        reasons=tuple(reasons),
        policy_version=pol.version,
        evaluated_at=_evaluated_at(receipt, ctx),
    )
