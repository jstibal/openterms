"""Types for the OpenTerms deterministic policy engine.

These dataclasses describe the inputs and outputs of ``openterms.policy.evaluate``.
They mirror the OpenAPI ``Rule``, ``Policy``, ``Decision`` and ``DecisionOutcome``
schemas in ``openapi.yaml`` (the API service is the production consumer; this
SDK implementation is the reference deterministic evaluator).

The engine is pure: given a ``Policy``, a ``Receipt`` (the signed ORS receipt as
a plain dict) and an ``EvalContext`` carrying any pre-computed aggregates and
the per-evaluation deadline, evaluation produces the same ``Decision`` byte for
byte every time it is run. See ``openterms.policy.evaluate`` for the orchestrator
and the determinism guarantees it enforces.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

DecisionOutcome = Literal["allow", "deny", "escalate"]

RuleType = Literal[
    "max_amount",
    "daily_limit",
    "action_type_allowlist",
    "action_type_denylist",
    "url_prefix_allowlist",
    "url_prefix_denylist",
    "escalation_threshold",
    "tool_id_allowlist",
    "args_pattern_match",
    "post_state_assertion",
]

VALID_OUTCOMES: tuple[DecisionOutcome, ...] = ("allow", "deny", "escalate")
VALID_RULE_TYPES: tuple[RuleType, ...] = (
    "max_amount",
    "daily_limit",
    "action_type_allowlist",
    "action_type_denylist",
    "url_prefix_allowlist",
    "url_prefix_denylist",
    "escalation_threshold",
    "tool_id_allowlist",
    "args_pattern_match",
    "post_state_assertion",
)


@dataclass(frozen=True)
class Rule:
    id: str
    type: RuleType
    outcome: DecisionOutcome
    parameters: dict[str, Any]

    @staticmethod
    def from_dict(d: dict[str, Any]) -> Rule:
        for k in ("id", "type", "outcome", "parameters"):
            if k not in d:
                raise ValueError(f"Rule is missing required field '{k}'")
        if d["type"] not in VALID_RULE_TYPES:
            raise ValueError(f"Unknown rule type: {d['type']!r}")
        if d["outcome"] not in VALID_OUTCOMES:
            raise ValueError(f"Invalid outcome: {d['outcome']!r}")
        if not isinstance(d["parameters"], dict):
            raise ValueError("Rule.parameters must be an object")
        return Rule(
            id=str(d["id"]),
            type=d["type"],
            outcome=d["outcome"],
            parameters=dict(d["parameters"]),
        )


@dataclass(frozen=True)
class Policy:
    version: str
    rules: tuple[Rule, ...]

    @staticmethod
    def from_dict(d: dict[str, Any]) -> Policy:
        version = str(d.get("version", "inline"))
        raw_rules = d.get("rules", [])
        if not isinstance(raw_rules, list):
            raise ValueError("Policy.rules must be a list")
        return Policy(version=version, rules=tuple(Rule.from_dict(r) for r in raw_rules))


@dataclass(frozen=True)
class RuleResult:
    """Outcome of evaluating a single rule against a receipt."""

    fired: bool
    reason: str = ""


@dataclass
class EvalContext:
    """Inputs the engine needs that are not on the receipt itself.

    ``aggregates`` is the caller's pre-computed snapshot used by ``daily_limit``
    rules. The mapping is keyed by an opaque string the rule constructs from its
    parameters (see :func:`openterms.policy_rules.eval_daily_limit`). The engine
    treats this snapshot as an input; it never reads from a database. This is
    what makes the engine pure: callers compute the snapshot deterministically
    from the append-only receipt log and the engine's output is a function of
    its arguments only.

    ``deadline_monotonic`` is the absolute deadline used to enforce the
    per-evaluation budget. ``None`` means no deadline (used only by tests that
    want to disable the budget; production callers always supply one).

    ``evaluated_at`` is the timestamp recorded in the ``Decision``. Defaults to
    the receipt's own ``created_at`` so the decision is reproducible from the
    receipt alone; callers may override.
    """

    aggregates: dict[str, int] = field(default_factory=dict)
    deadline_monotonic: float | None = None
    evaluated_at: str | None = None


@dataclass(frozen=True)
class Decision:
    decision: DecisionOutcome
    triggered_rules: tuple[str, ...]
    reasons: tuple[str, ...]
    policy_version: str
    evaluated_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "decision": self.decision,
            "triggered_rules": list(self.triggered_rules),
            "reasons": list(self.reasons),
            "policy_version": self.policy_version,
            "evaluated_at": self.evaluated_at,
        }


class PolicyTimeout(Exception):
    """Raised internally when the per-evaluation deadline trips.

    The engine catches this and converts it to a ``deny`` decision with a
    ``TIMEOUT`` reason; it is never raised to callers.
    """
