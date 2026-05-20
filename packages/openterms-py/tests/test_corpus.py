"""Tests for the fixture corpus at ``tests/fixtures/corpus/``.

These tests cover three things:

1. The corpus loads and every receipt verifies against the JWKS.
2. The committed decisions are reproducible by re-running the engine.
3. The corpus is the byte-for-byte output of the generator script, so silent
   drift (a contributor edits the corpus without re-running the generator,
   or changes the engine without regenerating) is caught in CI.
"""

from __future__ import annotations

import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

import pytest

from openterms.verification import verify_receipt

REPO_ROOT = Path(__file__).resolve().parents[3]
CORPUS_DIR = REPO_ROOT / "tests" / "fixtures" / "corpus"
GEN_SCRIPT = REPO_ROOT / "packages" / "openterms-py" / "scripts" / "generate_corpus.py"


def _load(name: str):
    with (CORPUS_DIR / name).open("r", encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture(scope="module")
def receipts():
    return _load("receipts.json")


@pytest.fixture(scope="module")
def decisions():
    return _load("decisions.json")


@pytest.fixture(scope="module")
def jwks():
    return _load("jwks.json")


@pytest.fixture(scope="module")
def policy_v1():
    return _load("policy_v1.json")


@pytest.fixture(scope="module")
def policy_v2():
    return _load("policy_v2.json")


@pytest.fixture(scope="module")
def manifest():
    return _load("manifest.json")


@pytest.fixture(scope="module")
def simulation_diffs():
    return _load("simulation_expected_diffs.json")


def test_corpus_size(receipts):
    assert len(receipts) == 500


def test_every_signature_verifies(receipts, jwks):
    for r in receipts:
        result = verify_receipt(r, jwks)
        assert result.valid, (r["receipt_id"], result.error)


def test_jwks_contains_both_corpus_keys(jwks):
    kids = {k["kid"] for k in jwks["keys"]}
    assert kids == {"ot-corpus-2026a", "ot-corpus-2025z"}


def test_canonical_hashes_unique(receipts):
    hashes = [r["canonical_hash"] for r in receipts]
    assert len(set(hashes)) == len(hashes)


def test_decisions_reproducible(receipts, decisions, policy_v1):
    """Re-run the engine on every receipt and assert byte-equal to stored."""
    from openterms.policy import evaluate  # local import keeps fixture cheap

    daily_id = next(r["id"] for r in policy_v1["rules"] if r["type"] == "daily_limit")
    per_day: dict[str, int] = {}
    for receipt, stored in zip(receipts, decisions, strict=True):
        day = receipt["timestamp"][:10]
        aggs = {daily_id: per_day.get(day, 0)}
        per_day[day] = per_day.get(day, 0) + int(receipt["amount_charged"])
        decision = evaluate(receipt, policy_v1, aggregates=aggs, budget_seconds=0.1)
        assert decision.decision == stored["decision"]
        assert list(decision.triggered_rules) == stored["triggered_rules"]
        assert list(decision.reasons) == stored["reasons"]
        assert decision.policy_version == stored["policy_version"]
        assert decision.evaluated_at == stored["evaluated_at"]


def test_decision_distribution_in_tolerance(decisions):
    counts = Counter(d["decision"] for d in decisions)
    n = len(decisions)
    assert abs(counts["allow"] / n - 0.70) <= 0.05
    assert abs(counts["deny"] / n - 0.20) <= 0.05
    assert abs(counts["escalate"] / n - 0.10) <= 0.05


def test_each_rule_fires_at_least_ten_times(decisions, policy_v1):
    firings: Counter[str] = Counter()
    for d in decisions:
        firings.update(d["triggered_rules"])
    for rule in policy_v1["rules"]:
        assert firings[rule["id"]] >= 10, (rule["id"], firings[rule["id"]])


def test_all_five_action_types_present(receipts):
    types = {r["action_type"] for r in receipts}
    assert types == {"api_call", "data_access", "purchase", "custom", "model_training"}


def test_chain_parents_resolve(receipts):
    id_to_index = {r["receipt_id"]: i for i, r in enumerate(receipts)}
    seen_chain = False
    for i, r in enumerate(receipts):
        chain = r.get("action_context", {}).get("ors", {}).get("chain")
        if not chain:
            continue
        seen_chain = True
        parent = chain.get("parent_receipt_id")
        if parent is not None:
            assert parent in id_to_index and id_to_index[parent] < i
    assert seen_chain, "expected at least one chained receipt"


def test_optional_fields_have_coverage(receipts):
    """Each optional field exercised by at least one receipt — sanity check
    that the generator's coverage knobs are wired correctly."""
    has_provider = any("provider" in r for r in receipts)
    has_request_binding = any("request_binding" in r for r in receipts)
    has_ors_version = any(r.get("ors_version") == "0.2" for r in receipts)
    has_commitments = any(
        r.get("action_context", {}).get("ors", {}).get("commitments") for r in receipts
    )
    has_no_action_context = any("action_context" not in r for r in receipts)
    assert has_provider
    assert has_request_binding
    assert has_ors_version
    assert has_commitments
    assert has_no_action_context


def test_simulation_diff_oracle_present(simulation_diffs):
    """The simulation oracle exists and references receipts by canonical_hash."""
    assert len(simulation_diffs) > 0
    for entry in simulation_diffs:
        assert set(entry.keys()) == {"receipt_hash", "v1", "v2"}
        assert entry["v1"]["decision"] != entry["v2"]["decision"] or (
            entry["v1"]["triggered_rules"] != entry["v2"]["triggered_rules"]
        )


def test_corpus_regeneration_is_byte_identical():
    """Run the generator in --check mode against the committed corpus.

    If this test fails, a contributor has changed something (engine, generator,
    or scenario inputs) that affects the corpus output and needs to re-run
    ``python3 packages/openterms-py/scripts/generate_corpus.py`` and commit.
    """
    result = subprocess.run(
        [sys.executable, str(GEN_SCRIPT), "--check"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, (
        f"corpus is stale.\nstdout: {result.stdout}\nstderr: {result.stderr}"
    )
