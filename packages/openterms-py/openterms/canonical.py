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
  * Floats are REJECTED at canonicalize() time. Python ``repr`` and
    JavaScript ``Number.prototype.toString`` do not agree on every IEEE-754
    double, so silent pass-through risks cross-language divergence. Encode
    monetary amounts as integer cents, not as floats.
  * Non-BMP object keys are REJECTED. They would sort differently in JS
    (UTF-16 code units) vs Python (Unicode code points), producing
    divergent canonical bytes.
  * Integers beyond ``Number.MAX_SAFE_INTEGER`` (2**53 - 1) are REJECTED
    for the same reason — JS Number cannot represent them exactly. Encode
    such values as strings.
  * Key sort is by Python's default string ordering (Unicode code point).
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


class CanonicalizationError(ValueError):
    """Raised when a value cannot be canonicalized identically across languages."""


# Beyond this magnitude, JavaScript's Number cannot represent the integer
# exactly, so the JS port emits a different string than Python would.
# Reject at canonicalization time to avoid silent cross-language divergence.
_MAX_SAFE_INTEGER = 9007199254740991  # 2**53 - 1


def _validate(obj: Any) -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            if not isinstance(k, str):
                raise CanonicalizationError(
                    f"Object keys must be strings; got {type(k).__name__}"
                )
            # Non-BMP keys would sort differently in JS (UTF-16 code units)
            # vs Python (Unicode code points), producing divergent canonical
            # bytes. Reject explicitly.
            for ch in k:
                if ord(ch) > 0xFFFF:
                    raise CanonicalizationError(
                        "Object key contains a non-BMP (supplementary-plane) "
                        f"character; not supported by ORS v0.1 canonicalization: {k!r}"
                    )
            _validate(v)
        return
    if isinstance(obj, list):
        for v in obj:
            _validate(v)
        return
    if isinstance(obj, bool):
        return  # bool is a subclass of int; check before int
    if isinstance(obj, int):
        if abs(obj) > _MAX_SAFE_INTEGER:
            raise CanonicalizationError(
                f"Integer {obj} exceeds JavaScript Number.MAX_SAFE_INTEGER; "
                "encode as a string instead"
            )
        return
    if isinstance(obj, float):
        # Floats cannot round-trip identically between Python's repr() and
        # JS's Number.prototype.toString in all cases. NaN/Infinity also
        # fail allow_nan=False downstream, but reject up-front for clearer
        # error messages.
        raise CanonicalizationError(
            f"Float values are not allowed in ORS v0.1 canonical receipts (got {obj!r})"
        )
    # str, None, and other JSON-leaf values are fine.


def strip_nulls(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: strip_nulls(v) for k, v in obj.items() if v is not None}
    if isinstance(obj, list):
        return [strip_nulls(v) for v in obj]
    return obj


def canonicalize(payload: dict) -> bytes:
    _validate(payload)
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
