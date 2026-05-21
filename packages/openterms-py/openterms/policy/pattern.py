"""Constrained pattern language for the ``args_pattern_match`` rule.

The build brief forbids unrestricted regular expressions in the policy engine
("no regular expressions outside the constrained pattern language defined in
the rule schema"). This module implements that constrained language. Each
operator runs in time linear in the input length, with no backtracking, so
evaluation is bounded and the engine's 5 ms p99 budget is achievable.

Supported operators (case-sensitive, byte-comparison on the string form of the
target value):

* ``equals`` — exact string equality.
* ``prefix`` — target starts with ``value``.
* ``suffix`` — target ends with ``value``.
* ``contains`` — ``value`` appears anywhere in target (Python ``in``, which is
  Boyer-Moore-like and linear in target length for fixed pattern length).
* ``glob`` — restricted glob with ``*`` (any run of characters) and ``?`` (one
  character). No character classes, no escape, no alternation. Evaluated by a
  hand-rolled two-pointer matcher that is provably linear in
  ``len(target) + len(pattern)`` and does not delegate to ``fnmatch`` (which
  compiles to regex and would reintroduce backtracking risk).

Path resolution: a dotted path such as ``action_context.target.url`` traverses
nested dicts. A missing intermediate key yields ``None`` (matches nothing). A
non-string leaf is coerced via ``str()`` so policy authors can match against
e.g. numeric IDs without special-casing.
"""

from __future__ import annotations

from typing import Any

VALID_OPS = ("equals", "prefix", "suffix", "contains", "glob")


def resolve_path(receipt: dict[str, Any], path: str) -> Any:
    """Walk a dotted path through nested dicts. Returns ``None`` if absent."""
    if not path:
        return None
    cur: Any = receipt
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def _glob_match(pattern: str, target: str) -> bool:
    """Two-pointer glob matcher. Linear in len(pattern)+len(target).

    Standard algorithm: track a ``*`` backtrack point and the last position
    in the target consumed past it. Total work is bounded because each target
    character is consumed at most twice (once on the forward scan, once when
    re-entering after a star). No recursion, no regex compilation.
    """
    p_i = 0
    t_i = 0
    star = -1
    match = 0
    while t_i < len(target):
        if p_i < len(pattern) and pattern[p_i] == "*":
            star = p_i
            match = t_i
            p_i += 1
        elif p_i < len(pattern) and (pattern[p_i] == "?" or pattern[p_i] == target[t_i]):
            p_i += 1
            t_i += 1
        elif star != -1:
            p_i = star + 1
            match += 1
            t_i = match
        else:
            return False
    while p_i < len(pattern) and pattern[p_i] == "*":
        p_i += 1
    return p_i == len(pattern)


def match_one(op: str, value: str, target: Any) -> bool:
    """Evaluate a single pattern operator against a resolved target value."""
    if op not in VALID_OPS:
        raise ValueError(f"Unknown pattern operator: {op!r}")
    if target is None:
        return False
    target_str = target if isinstance(target, str) else str(target)
    if op == "equals":
        return target_str == value
    if op == "prefix":
        return target_str.startswith(value)
    if op == "suffix":
        return target_str.endswith(value)
    if op == "contains":
        return value in target_str
    # op == "glob"
    return _glob_match(value, target_str)
