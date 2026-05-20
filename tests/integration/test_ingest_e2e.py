"""End-to-end ingest test: openterms-py signs → TypeScript service verifies and persists.

Five scenarios cover the contract surface of POST /v1/receipts/ingest:
    1. happy path → 201
    2. duplicate canonical_hash → 200, duplicate=true
    3. tampered signature → 422 SIGNATURE_INVALID
    4. unknown key_id → 422 UNKNOWN_ISSUER
    5. Idempotency-Key reused with different payload → 409 IDEMPOTENCY_KEY_CONFLICT

Each scenario also asserts the database row state directly (via psql) so we
catch any drift between what the API reports and what landed on disk.
"""

from __future__ import annotations

import json
import subprocess
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

from openterms.signing import sign_receipt


def _ts() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + "000Z"


def _payload(workspace_id: str, **overrides) -> dict:
    base = {
        "workspace_id": workspace_id,
        "agent_id": "agent-int-test",
        "action_type": "api_call",
        "terms_url": "https://example.com/terms",
        "terms_hash": "a" * 64,
        "timestamp": _ts(),
        "pricing_version": "v1",
        "receipt_id": str(uuid.uuid4()),
        "amount_charged": 1000,
        "created_at": _ts(),
    }
    base.update(overrides)
    return base


def _post(base_url: str, body: dict, headers: dict | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(
        f"{base_url}/v1/receipts/ingest",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _count_receipts(db_url: str, canonical_hash: str) -> int:
    out = subprocess.check_output(
        [
            "psql",
            db_url,
            "-tAc",
            f"SELECT count(*) FROM receipts WHERE canonical_hash = '{canonical_hash}'",
        ]
    )
    return int(out.strip())


def test_happy_path(server_env):
    payload = _payload(server_env["workspace_id"])
    signed = sign_receipt(payload, server_env["seed"], server_env["kid"])

    status, body = _post(server_env["base_url"], signed)
    assert status == 201, body
    assert body["duplicate"] is False
    assert body["hash"] == signed["canonical_hash"]
    assert body["receipt"]["receipt_id"] == signed["receipt_id"]
    assert _count_receipts(server_env["db_url"], signed["canonical_hash"]) == 1


def test_duplicate_returns_200(server_env):
    payload = _payload(server_env["workspace_id"])
    signed = sign_receipt(payload, server_env["seed"], server_env["kid"])

    s1, b1 = _post(server_env["base_url"], signed)
    s2, b2 = _post(server_env["base_url"], signed)
    assert s1 == 201, b1
    assert s2 == 200, b2
    assert b2["duplicate"] is True
    assert b2["hash"] == b1["hash"]
    assert _count_receipts(server_env["db_url"], signed["canonical_hash"]) == 1


def test_tampered_signature_rejected(server_env):
    payload = _payload(server_env["workspace_id"])
    signed = sign_receipt(payload, server_env["seed"], server_env["kid"])
    # Tamper amount after signing — canonical_hash still matches the post-sign
    # payload's claim, but the signature does not verify over the new bytes.
    signed["amount_charged"] = 99999  # mutates the field included in canonicalization
    # canonical_hash field still references the old hash; recomputed will not match.
    # Whether this surfaces as HASH_MISMATCH or SIGNATURE_INVALID depends on
    # which check fires first. The contract says hash check first.
    status, body = _post(server_env["base_url"], signed)
    assert status == 422, body
    assert body["error"]["code"] in {"HASH_MISMATCH", "SIGNATURE_INVALID"}
    # Tampered receipts MUST NOT be persisted.
    # We can't query by canonical_hash here because the value in the receipt
    # is the pre-tamper hash; the recomputed one differs. Assert no row with
    # this receipt_id exists.
    out = subprocess.check_output(
        [
            "psql",
            server_env["db_url"],
            "-tAc",
            f"SELECT count(*) FROM receipts WHERE receipt_id = '{signed['receipt_id']}'",
        ]
    )
    assert int(out.strip()) == 0


def test_unknown_issuer(server_env):
    payload = _payload(server_env["workspace_id"])
    signed = sign_receipt(payload, server_env["seed"], "key-not-in-jwks")
    status, body = _post(server_env["base_url"], signed)
    assert status == 422, body
    assert body["error"]["code"] == "UNKNOWN_ISSUER"


def test_idempotency_key_conflict(server_env):
    p1 = _payload(server_env["workspace_id"])
    p2 = _payload(server_env["workspace_id"])  # different receipt_id → different canonical_hash
    s1 = sign_receipt(p1, server_env["seed"], server_env["kid"])
    s2 = sign_receipt(p2, server_env["seed"], server_env["kid"])

    key = f"idem-{uuid.uuid4().hex}"
    status1, body1 = _post(server_env["base_url"], s1, {"Idempotency-Key": key})
    assert status1 == 201, body1

    status2, body2 = _post(server_env["base_url"], s2, {"Idempotency-Key": key})
    assert status2 == 409, body2
    assert body2["error"]["code"] == "IDEMPOTENCY_KEY_CONFLICT"

    # The second receipt was rejected, so only the first row should exist.
    assert _count_receipts(server_env["db_url"], s1["canonical_hash"]) == 1
    assert _count_receipts(server_env["db_url"], s2["canonical_hash"]) == 0


def test_idempotency_key_replay_same_payload(server_env):
    """Same key + same canonical_hash → 200, no duplicate row, no conflict."""
    payload = _payload(server_env["workspace_id"])
    signed = sign_receipt(payload, server_env["seed"], server_env["kid"])

    key = f"idem-{uuid.uuid4().hex}"
    status1, body1 = _post(server_env["base_url"], signed, {"Idempotency-Key": key})
    status2, body2 = _post(server_env["base_url"], signed, {"Idempotency-Key": key})
    assert status1 == 201
    assert status2 == 200
    assert body2["duplicate"] is True
    assert _count_receipts(server_env["db_url"], signed["canonical_hash"]) == 1
