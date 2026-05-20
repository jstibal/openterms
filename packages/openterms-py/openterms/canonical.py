"""ORS v0.1 canonicalization.

Implements Section 4 of the Open Receipt Specification v0.1
(https://github.com/jstibal/ors-spec/blob/main/ORS-v0.1.md): RFC 8785 JSON
Canonicalization Scheme plus recursive null-stripping from objects.

Provenance note. BUILD_BRIEF Step 2 instructs porting canonicalization from a
legacy ``server/core/canonical.ts`` file. That file is not present in this
repository. This implementation is written directly against the ORS v0.1 spec
and matches the behavior of the reference verifier ``verify.py`` in
``jstibal/ors-spec`` so that receipts produced here pass third-party
verification by construction. The future TypeScript port should achieve
cross-language parity by passing the same test vectors at
``tests/vectors/ors-v0.1/canonicalization.json``, not by chasing the missing
legacy file.

Corner-case decisions (the spec is silent or ambiguous on each; behavior here
matches ``verify.py``):

  * Null stripping applies to objects only. Nulls inside arrays are preserved.
  * Empty containers (``{}`` and ``[]``) survive even after their last key was
    null-stripped; they are never pruned.
  * No Unicode normalization. NFC and NFD inputs produce different bytes.
  * Floats are emitted as Python's ``json.dumps`` writes them. The ORS spec
    says floats SHOULD NOT appear in payloads; the SDK input layer is where to
    enforce integer-only, not here.
  * Key sort is by Python's default string ordering (Unicode code point).
    Cross-language parity with JS (UTF-16 code unit) is only guaranteed for
    keys in the Basic Multilingual Plane.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

DOMAIN_SEPARATOR = b"ORSv0.1\x00"

PAYLOAD_KEYS_REQUIRED = (
    "workspace_id",
    "agent_id",
    "action_type",
    "terms_url",
    "terms_hash",
    "timestamp",
    "pricing_version",
)

PAYLOAD_KEYS_SIGNED_ENVELOPE = (
    "receipt_id",
    "amount_charged",
    "created_at",
)

PAYLOAD_KEYS_OPTIONAL = (
    "action_context",
    "ors_version",
    "issuer",
    "provider",
    "decision",
    "request_binding",
)


def strip_nulls(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: strip_nulls(v) for k, v in obj.items() if v is not None}
    if isinstance(obj, list):
        return [strip_nulls(v) for v in obj]
    return obj


def canonicalize(payload: dict) -> bytes:
    cleaned = strip_nulls(payload)
    canonical_str = json.dumps(
        cleaned,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
    return canonical_str.encode("utf-8")


def canonical_hash(payload: dict) -> str:
    return hashlib.sha256(canonicalize(payload)).hexdigest()


def signing_input(payload: dict) -> bytes:
    """Return the 40-byte Ed25519 message: domain separator + raw SHA-256."""
    digest = hashlib.sha256(canonicalize(payload)).digest()
    return DOMAIN_SEPARATOR + digest


def build_payload(receipt: dict) -> dict:
    """Extract the signed payload from a full receipt envelope.

    Excludes Section 3c signature metadata (``canonical_hash``, ``signature``,
    ``key_id``). Optional fields are included only if present and non-null.
    """
    payload: dict = {}
    for k in PAYLOAD_KEYS_REQUIRED:
        if k not in receipt:
            raise ValueError(f"Missing required payload field: {k}")
        payload[k] = receipt[k]
    for k in PAYLOAD_KEYS_SIGNED_ENVELOPE:
        if k not in receipt:
            raise ValueError(f"Missing required signed envelope field: {k}")
        payload[k] = receipt[k]
    for k in PAYLOAD_KEYS_OPTIONAL:
        if k in receipt and receipt[k] is not None:
            payload[k] = receipt[k]
    return payload
