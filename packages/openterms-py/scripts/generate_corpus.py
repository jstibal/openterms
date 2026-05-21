#!/usr/bin/env python3
"""Deterministic generator for the tests/fixtures/corpus/ artifact.

Run from the repo root:

    python3 packages/openterms-py/scripts/generate_corpus.py

Reads ``tests/fixtures/corpus/scenario.json`` plus ``policy_v1.json`` and
``policy_v2.json`` and emits:

    receipts.json, decisions.json, jwks.json, manifest.json,
    simulation_expected_diffs.json

The generator is fully deterministic: a single ``random.Random(seed)`` drives
every choice, key seeds derive from the same seed via SHA-256, and the output
files are sorted/keyed so two runs produce byte-identical bytes. The CI
regeneration test in ``tests/python/test_corpus.py`` re-runs the generator and
asserts the emitted files match the committed fixture.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import random
import subprocess
import sys
import uuid
from collections import Counter
from pathlib import Path
from typing import Any

# Make ``openterms`` importable when running from the repo root without an
# editable install. The generator is a build-time tool; we don't want to
# require a venv install just to regenerate fixtures.
REPO_ROOT = Path(__file__).resolve().parents[3]
SDK_ROOT = REPO_ROOT / "packages" / "openterms-py"
if str(SDK_ROOT) not in sys.path:
    sys.path.insert(0, str(SDK_ROOT))

from cryptography.hazmat.primitives.asymmetric.ed25519 import (  # noqa: E402
    Ed25519PrivateKey,
)

from openterms.policy import evaluate  # noqa: E402
from openterms.signing import (  # noqa: E402
    build_jwks,
    sign_receipt,
)
from openterms.verification import verify_receipt  # noqa: E402

CORPUS_DIR = REPO_ROOT / "tests" / "fixtures" / "corpus"

BUCKET_ORDER = [
    "model_training",
    "max_amount",
    "url_off_list",
    "url_blocked",
    "args_debug",
    "daily_limit",
    "escalation_only",
    "tool_off_list",
    "post_state_mismatch",
    "stress",
    "allow",
]

def _load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _dump_json(path: Path, value: Any) -> None:
    text = json.dumps(value, indent=2, ensure_ascii=False, sort_keys=False)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(text)
        f.write("\n")


def derive_key_seed(master_seed: int, kid: str) -> bytes:
    h = hashlib.sha256()
    h.update(b"openterms-corpus-key-derivation-v1\x00")
    h.update(master_seed.to_bytes(8, "big"))
    h.update(b"\x00")
    h.update(kid.encode("utf-8"))
    return h.digest()


def deterministic_uuid_v4(rng: random.Random) -> str:
    b = bytearray(rng.randbytes(16))
    b[6] = (b[6] & 0x0F) | 0x40
    b[8] = (b[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(b)))


def deterministic_hex(rng: random.Random, n_bytes: int = 32) -> str:
    return rng.randbytes(n_bytes).hex()


def to_iso_z(when: dt.datetime) -> str:
    # Force ms precision + Z. The receipt schema requires exactly this shape.
    return when.strftime("%Y-%m-%dT%H:%M:%S.") + f"{when.microsecond // 1000:03d}Z"


def parse_iso_z(text: str) -> dt.datetime:
    return dt.datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
        tzinfo=dt.timezone.utc
    )


def utc_day_of(text: str) -> str:
    return text[:10]


def build_bucket_assignments(scenario: dict[str, Any]) -> list[str]:
    counts = scenario["buckets"]
    out: list[str] = []
    for bucket in BUCKET_ORDER:
        out.extend([bucket] * counts[bucket])
    if len(out) != scenario["count"]:
        raise ValueError(
            f"bucket counts sum to {len(out)} but scenario.count is {scenario['count']}"
        )
    return out


def assign_timestamps(scenario: dict[str, Any], buckets: list[str]) -> list[dt.datetime]:
    """Deterministic timestamps.

    Most receipts land uniformly across the 30-day window. Daily-limit
    receipts cluster on two specific UTC days so their cumulative amount
    crosses the daily_limit threshold.
    """
    start = parse_iso_z(scenario["time_window"]["start"])
    end = parse_iso_z(scenario["time_window"]["end"])
    total_ms = int((end - start).total_seconds() * 1000)
    n = len(buckets)

    # Cluster days for daily_limit. Two fixed offsets into the window so the
    # cumulative-by-day aggregation produces predictable firings.
    cluster_day_offsets = [5, 18]  # day index within window

    timestamps: list[dt.datetime] = []
    daily_count = 0
    for i, bucket in enumerate(buckets):
        if bucket == "daily_limit":
            # Alternate between the two cluster days, spread by hour within day.
            day_idx = cluster_day_offsets[daily_count % 2]
            hour = (daily_count // 2) * 2
            offset_ms = day_idx * 86_400_000 + hour * 3_600_000
            daily_count += 1
        else:
            offset_ms = (i * total_ms) // max(n - 1, 1)
        when = start + dt.timedelta(milliseconds=offset_ms)
        timestamps.append(when)
    # Sort timestamps so output is chronological; keep bucket assignment in
    # lockstep by sorting both arrays together.
    paired = sorted(zip(timestamps, buckets, strict=True), key=lambda p: p[0])
    return paired  # type: ignore[return-value]


def pick(rng: random.Random, values: list[str]) -> str:
    return values[rng.randrange(len(values))]


def build_receipt_payload(
    *,
    rng: random.Random,
    scenario: dict[str, Any],
    bucket: str,
    when: dt.datetime,
    receipt_id: str,
    chain_state: dict[str, Any],
) -> dict[str, Any]:
    workspace_id = scenario["workspace_id"]
    agent_id = pick(rng, scenario["agents"])
    action_type: str
    amount: int
    terms_url: str
    tool_id: str | None
    include_commitments = True
    include_chain = False
    include_provider = rng.random() < 0.20
    include_request_binding = rng.random() < 0.10
    include_v02_fields = rng.random() < 0.05
    post_state_hash: str | None = None
    extra_commit: dict[str, Any] = {}

    if bucket == "model_training":
        action_type = "model_training"
        amount = rng.randrange(100, 500_000)
        terms_url = pick(rng, scenario["terms_urls_allowed"])
        tool_id = pick(rng, scenario["tools_allowed"])
    elif bucket == "max_amount":
        action_type = pick(rng, ["api_call", "data_access", "purchase", "custom"])
        amount = rng.randrange(
            scenario["amounts"]["max_amount_min"], scenario["amounts"]["max_amount_max"] + 1
        )
        terms_url = pick(rng, scenario["terms_urls_allowed"])
        tool_id = pick(rng, scenario["tools_allowed"])
    elif bucket == "url_off_list":
        action_type = pick(rng, ["api_call", "data_access", "purchase", "custom"])
        amount = rng.randrange(0, scenario["amounts"]["allow_max"] + 1)
        terms_url = scenario["terms_url_off_list"]
        tool_id = pick(rng, scenario["tools_allowed"])
    elif bucket == "url_blocked":
        action_type = pick(rng, ["api_call", "data_access", "purchase", "custom"])
        amount = rng.randrange(0, scenario["amounts"]["allow_max"] + 1)
        terms_url = scenario["terms_url_blocked"]
        tool_id = pick(rng, scenario["tools_allowed"])
    elif bucket == "args_debug":
        action_type = pick(rng, ["api_call", "data_access", "custom"])
        amount = rng.randrange(0, scenario["amounts"]["allow_max"] + 1)
        terms_url = pick(rng, scenario["terms_urls_allowed"])
        tool_id = scenario["tool_debug"]
    elif bucket == "daily_limit":
        action_type = pick(rng, ["api_call", "purchase"])
        amount = scenario["amounts"]["daily_limit_per_receipt"]
        terms_url = pick(rng, scenario["terms_urls_allowed"])
        tool_id = pick(rng, scenario["tools_allowed"])
    elif bucket == "escalation_only":
        action_type = pick(rng, ["api_call", "data_access", "purchase", "custom"])
        # Stay strictly under max_amount (5M) and at-or-above escalation (1M).
        amount = rng.randrange(
            scenario["amounts"]["escalation_only_min"],
            scenario["amounts"]["escalation_only_max"] + 1,
        )
        terms_url = pick(rng, scenario["terms_urls_allowed"])
        tool_id = pick(rng, scenario["tools_allowed"])
    elif bucket == "tool_off_list":
        action_type = pick(rng, ["api_call", "data_access", "custom"])
        amount = rng.randrange(0, scenario["amounts"]["allow_max"] + 1)
        terms_url = pick(rng, scenario["terms_urls_allowed"])
        tool_id = pick(rng, scenario["tools_off_list"])
    elif bucket == "post_state_mismatch":
        action_type = pick(rng, ["api_call", "data_access", "custom"])
        amount = rng.randrange(0, scenario["amounts"]["allow_max"] + 1)
        terms_url = pick(rng, scenario["terms_urls_allowed"])
        tool_id = pick(rng, scenario["tools_allowed"])
        # Non-zero hash that won't match the expected sentinel.
        post_state_hash = deterministic_hex(rng)
    elif bucket == "stress":
        # Combines model_training + max_amount + url_off_list to exercise the
        # 3+-rule-fired audit path.
        action_type = "model_training"
        amount = rng.randrange(
            scenario["amounts"]["stress_min"], scenario["amounts"]["stress_max"] + 1
        )
        terms_url = scenario["terms_url_off_list"]
        tool_id = pick(rng, scenario["tools_allowed"])
    elif bucket == "allow":
        action_type = pick(rng, ["api_call", "data_access", "purchase", "custom"])
        amount = rng.randrange(0, scenario["amounts"]["allow_max"] + 1)
        terms_url = pick(rng, scenario["terms_urls_allowed"])
        # 5% omit commitments entirely.
        if rng.random() < 0.05:
            include_commitments = False
            tool_id = None
        else:
            tool_id = pick(rng, scenario["tools_allowed"])
        # 15% chain membership, only on allow path so chains don't muddle other buckets.
        include_chain = rng.random() < 0.18
    else:
        raise AssertionError(f"unknown bucket {bucket!r}")

    payload: dict[str, Any] = {
        "workspace_id": workspace_id,
        "agent_id": agent_id,
        "action_type": action_type,
        "terms_url": terms_url,
        "terms_hash": deterministic_hex(rng),
        "timestamp": to_iso_z(when),
        "pricing_version": "2026-q2",
        "receipt_id": receipt_id,
        "amount_charged": amount,
        "created_at": to_iso_z(when + dt.timedelta(milliseconds=1)),
        "issuer": scenario["issuer"],
    }

    if include_commitments:
        commitments: dict[str, Any] = {}
        if tool_id is not None:
            commitments["tool_id"] = tool_id
        # ~half of commitments-bearing receipts also include args_hash.
        if rng.random() < 0.5:
            commitments["args_hash"] = deterministic_hex(rng)
        if post_state_hash is not None:
            commitments["post_state_hash"] = post_state_hash
        elif rng.random() < 0.15:
            commitments["pre_state_hash"] = deterministic_hex(rng)
            commitments["post_state_hash"] = (
                "0000000000000000000000000000000000000000000000000000000000000000"
            )
        if commitments:
            extra_commit = {"ors": {"commitments": commitments}}

    action_context: dict[str, Any] = {}
    if extra_commit:
        action_context.setdefault("ors", {}).update(extra_commit["ors"])

    if include_chain:
        # Build chains of up to depth 3 by carrying state across receipts.
        chain = chain_state
        if chain.get("active") and chain.get("depth", 0) < 3:
            action_context.setdefault("ors", {})["chain"] = {
                "parent_receipt_id": chain["parent_receipt_id"],
                "chain_id": chain["chain_id"],
                "chain_depth": chain["depth"],
                "originating_agent": chain["originating_agent"],
            }
            chain["parent_receipt_id"] = receipt_id
            chain["depth"] += 1
        else:
            chain_id = "chain-" + deterministic_hex(rng, 4)
            action_context.setdefault("ors", {})["chain"] = {
                "chain_id": chain_id,
                "chain_depth": 0,
                "originating_agent": agent_id,
            }
            chain["active"] = True
            chain["chain_id"] = chain_id
            chain["parent_receipt_id"] = receipt_id
            chain["depth"] = 1
            chain["originating_agent"] = agent_id
    else:
        chain_state["active"] = False

    if action_context:
        payload["action_context"] = action_context

    if include_provider:
        payload["provider"] = {
            "origin": "https://api.openai.com",
            "provider_id": "openai",
        }
    if include_request_binding:
        payload["request_binding"] = {
            "provider_nonce": deterministic_hex(rng, 16),
            "binding_method": "provider_nonce",
        }
    if include_v02_fields:
        # NOTE: the Python SDK currently treats terms_type/terms_service/
        # terms_version as unknown signed keys (canonical.py:56). Until the
        # SDK is updated for ORS v0.2, the corpus only flags ors_version on
        # these receipts.
        payload["ors_version"] = "0.2"

    return payload


def compute_daily_aggregates(
    receipts: list[dict[str, Any]], rule_id: str
) -> list[dict[str, int]]:
    """For each receipt index, the cumulative amount on the same UTC day
    prior to this receipt. Mirrors what the live aggregate snapshot in the
    API would compute under the daily_limit rule.
    """
    per_day: dict[str, int] = {}
    out: list[dict[str, int]] = []
    for r in receipts:
        day = utc_day_of(r["timestamp"])
        prior = per_day.get(day, 0)
        out.append({rule_id: prior})
        per_day[day] = prior + int(r["amount_charged"])
    return out


def find_rule_id(policy: dict[str, Any], rule_type: str) -> str:
    for r in policy["rules"]:
        if r["type"] == rule_type:
            return r["id"]
    raise KeyError(f"policy has no rule of type {rule_type!r}")


def evaluate_corpus(
    receipts: list[dict[str, Any]],
    policy: dict[str, Any],
) -> list[dict[str, Any]]:
    rule_id = find_rule_id(policy, "daily_limit")
    aggs = compute_daily_aggregates(receipts, rule_id)
    decisions: list[dict[str, Any]] = []
    for r, agg in zip(receipts, aggs, strict=True):
        decision = evaluate(r, policy, aggregates=agg, budget_seconds=0.1)
        decisions.append(
            {
                "receipt_hash": r["canonical_hash"],
                "decision": decision.decision,
                "triggered_rules": list(decision.triggered_rules),
                "reasons": list(decision.reasons),
                "policy_version": decision.policy_version,
                "evaluated_at": decision.evaluated_at,
            }
        )
    return decisions


def make_keys(scenario: dict[str, Any]) -> dict[str, tuple[Ed25519PrivateKey, dict]]:
    keys: dict[str, tuple[Ed25519PrivateKey, dict]] = {}
    master = int(scenario["seed"])
    for entry in scenario["keys"]:
        kid = entry["kid"]
        seed_bytes = derive_key_seed(master, kid)
        sk = Ed25519PrivateKey.from_private_bytes(seed_bytes)
        keys[kid] = (sk, entry)
    return keys


def module_tree_sha(repo_root: Path) -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD:packages/openterms-py"],
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "unknown"


def scenario_canonical_hash(scenario: dict[str, Any]) -> str:
    # Provenance hash of the scenario file. Cannot use openterms.canonical
    # here because scenario.json legitimately contains floats (key share
    # weights for random.choices), which the ORS canonicalizer rejects.
    # A plain sort_keys json.dumps is sufficient for a deterministic
    # fingerprint over a file we control.
    return hashlib.sha256(
        json.dumps(scenario, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def validate_corpus(
    scenario: dict[str, Any],
    receipts: list[dict[str, Any]],
    decisions: list[dict[str, Any]],
    jwks: dict[str, Any],
    policy_v1: dict[str, Any],
) -> dict[str, Any]:
    n = len(receipts)
    # 1. Signature verification.
    for r in receipts:
        result = verify_receipt(r, jwks)
        if not result.valid:
            raise AssertionError(
                f"signature verification failed for {r['receipt_id']}: {result.error}"
            )

    # 2. Decision reproducibility (recomputed from scratch).
    reproduced = evaluate_corpus(receipts, policy_v1)
    if reproduced != decisions:
        # Find first diff for the error message.
        for i, (a, b) in enumerate(zip(reproduced, decisions, strict=True)):
            if a != b:
                raise AssertionError(
                    f"decision reproducibility failed at index {i}: stored={b!r} reproduced={a!r}"
                )
        raise AssertionError("decision reproducibility failed (length mismatch)")

    # 3. Distribution tolerance + rule-firing minimums.
    outcome_counts = Counter(d["decision"] for d in decisions)
    target = {"allow": 0.70, "deny": 0.20, "escalate": 0.10}
    for k, frac in target.items():
        actual = outcome_counts.get(k, 0) / n
        if abs(actual - frac) > 0.05:
            raise AssertionError(
                f"decision distribution out of tolerance for {k}: "
                f"actual={actual:.3f} target={frac:.3f}"
            )
    rule_firings: Counter[str] = Counter()
    for d in decisions:
        for rid in d["triggered_rules"]:
            rule_firings[rid] += 1
    for rule in policy_v1["rules"]:
        if rule_firings.get(rule["id"], 0) < 10:
            raise AssertionError(
                f"rule {rule['id']} fired only {rule_firings.get(rule['id'], 0)} times "
                f"(need ≥10)"
            )

    # 4. Canonical hash uniqueness.
    hashes = [r["canonical_hash"] for r in receipts]
    if len(set(hashes)) != n:
        raise AssertionError("duplicate canonical_hash values in corpus")

    # 5. Chain integrity.
    id_to_index = {r["receipt_id"]: i for i, r in enumerate(receipts)}
    for i, r in enumerate(receipts):
        chain = (
            r.get("action_context", {}).get("ors", {}).get("chain")
            if isinstance(r.get("action_context"), dict)
            else None
        )
        if not chain:
            continue
        parent_id = chain.get("parent_receipt_id")
        if parent_id is not None:
            if parent_id not in id_to_index or id_to_index[parent_id] >= i:
                raise AssertionError(
                    f"chain parent {parent_id} not found prior to receipt index {i}"
                )

    return {
        "outcome_counts": dict(outcome_counts),
        "rule_firings": dict(rule_firings),
        "action_type_counts": dict(Counter(r["action_type"] for r in receipts)),
    }


def compute_simulation_diffs(
    receipts: list[dict[str, Any]],
    v1_decisions: list[dict[str, Any]],
    policy_v2: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    v2_decisions = evaluate_corpus(receipts, policy_v2)
    diffs: list[dict[str, Any]] = []
    by_outcome: Counter[str] = Counter()
    for r, d1, d2 in zip(receipts, v1_decisions, v2_decisions, strict=True):
        if d1["decision"] != d2["decision"] or d1["triggered_rules"] != d2["triggered_rules"]:
            diffs.append(
                {
                    "receipt_hash": r["canonical_hash"],
                    "v1": {
                        "decision": d1["decision"],
                        "triggered_rules": d1["triggered_rules"],
                    },
                    "v2": {
                        "decision": d2["decision"],
                        "triggered_rules": d2["triggered_rules"],
                    },
                }
            )
            by_outcome[f"{d1['decision']}->{d2['decision']}"] += 1
    return diffs, dict(by_outcome)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--corpus-dir", default=str(CORPUS_DIR), help="Directory containing scenario + policies"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Generate to a temp dir and assert byte-for-byte equal to the committed corpus.",
    )
    args = parser.parse_args()

    corpus_dir = Path(args.corpus_dir)
    scenario = _load_json(corpus_dir / "scenario.json")
    policy_v1 = _load_json(corpus_dir / scenario["policy_v1"])
    policy_v2 = _load_json(corpus_dir / scenario["policy_v2"])

    rng = random.Random(scenario["seed"])

    keys = make_keys(scenario)
    jwks = build_jwks([(sk.public_key(), kid) for kid, (sk, _) in keys.items()])

    buckets = build_bucket_assignments(scenario)
    pairs = assign_timestamps(scenario, buckets)
    chain_state: dict[str, Any] = {"active": False}

    receipts: list[dict[str, Any]] = []
    for when, bucket in pairs:
        # Choose signing key by share weights.
        kid_choices = list(keys.keys())
        weights = [keys[k][1]["share"] for k in kid_choices]
        kid = rng.choices(kid_choices, weights=weights, k=1)[0]
        receipt_id = deterministic_uuid_v4(rng)
        payload = build_receipt_payload(
            rng=rng,
            scenario=scenario,
            bucket=bucket,
            when=when,
            receipt_id=receipt_id,
            chain_state=chain_state,
        )
        sk = keys[kid][0]
        signed = sign_receipt(payload, sk, kid)
        receipts.append(signed)

    decisions = evaluate_corpus(receipts, policy_v1)
    stats = validate_corpus(scenario, receipts, decisions, jwks, policy_v1)

    sim_diffs, sim_by_outcome = compute_simulation_diffs(
        receipts, decisions, policy_v2
    )

    manifest = {
        "scenario_canonical_hash": scenario_canonical_hash(scenario),
        "scenario_seed": scenario["seed"],
        "count": len(receipts),
        "openterms_module_tree_sha": module_tree_sha(REPO_ROOT),
        "policies": {
            "v1": policy_v1["version"],
            "v2": policy_v2["version"],
        },
        "stats": stats,
        "simulation_diffs_by_transition": sim_by_outcome,
        "simulation_total_diffs": len(sim_diffs),
    }

    outputs: list[tuple[str, Any]] = [
        ("receipts.json", receipts),
        ("decisions.json", decisions),
        ("jwks.json", jwks),
        ("simulation_expected_diffs.json", sim_diffs),
        ("manifest.json", manifest),
    ]

    if args.check:
        import io

        mismatched: list[str] = []
        for name, value in outputs:
            if name == "manifest.json":
                continue  # manifest contains a git SHA that drifts; skip.
            actual_path = corpus_dir / name
            existing = actual_path.read_text(encoding="utf-8") if actual_path.exists() else ""
            buf = io.StringIO()
            buf.write(json.dumps(value, indent=2, ensure_ascii=False, sort_keys=False))
            buf.write("\n")
            if buf.getvalue() != existing:
                mismatched.append(name)
        if mismatched:
            print(
                "corpus is stale; regenerate via "
                f"`python3 packages/openterms-py/scripts/generate_corpus.py`. "
                f"Mismatched: {mismatched}",
                file=sys.stderr,
            )
            return 1
        print("corpus check: OK")
        return 0

    for name, value in outputs:
        _dump_json(corpus_dir / name, value)
    print(
        f"wrote {len(receipts)} receipts to {corpus_dir} "
        f"(decisions={stats['outcome_counts']}, sim_diffs={len(sim_diffs)})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
