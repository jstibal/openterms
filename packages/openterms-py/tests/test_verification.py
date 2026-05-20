"""Failure-mode tests for ORS v0.1 verification.

Covers all six structured error codes defined by the spec §8 pseudocode plus
a positive control, a structural-error case, and an interop test against the
example receipts vendored from jstibal/ors-spec.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from openterms._b64 import b64url_decode, b64url_encode
from openterms.canonical import build_payload, canonicalize
from openterms.signing import build_jwks, generate_keypair, sign_receipt
from openterms.verification import verify_receipt

EXAMPLES_DIR = Path(__file__).parent / "vectors" / "ors-v0.1-examples"


def _payload() -> dict:
    return {
        "workspace_id": "550e8400-e29b-41d4-a716-446655440000",
        "agent_id": "agent-alpha",
        "action_type": "api_call",
        "terms_url": "https://api.example.com/terms",
        "terms_hash": "a" * 64,
        "timestamp": "2026-02-18T12:00:00.000Z",
        "pricing_version": "2025-01",
        "receipt_id": "550e8400-e29b-41d4-a716-446655440010",
        "amount_charged": 1000,
        "created_at": "2026-02-18T12:00:00.100Z",
    }


def _signed_with_jwks():
    sk, pk = generate_keypair()
    jwks = build_jwks([(pk, "k")])
    return sign_receipt(_payload(), sk, "k"), jwks, sk, pk


def test_positive_control():
    signed, jwks, _, _ = _signed_with_jwks()
    result = verify_receipt(signed, jwks)
    assert result.valid is True
    assert result.error is None


def test_hash_mismatch():
    # The tamper here changes ``amount_charged`` — a SIGNED PAYLOAD field, not
    # signature metadata. This documents the cryptographic property: any
    # modification to a signed payload field after signing causes the
    # recomputed canonical hash to diverge from the stored canonical_hash,
    # so the receipt fails before signature verification is even attempted.
    signed, jwks, _, _ = _signed_with_jwks()
    signed["amount_charged"] = 9999
    result = verify_receipt(signed, jwks)
    assert result.valid is False
    assert result.error == "HASH_MISMATCH"


def test_key_not_found():
    signed, _, _, _ = _signed_with_jwks()
    _, other_pk = generate_keypair()
    foreign_jwks = build_jwks([(other_pk, "different-kid")])
    result = verify_receipt(signed, foreign_jwks)
    assert result.valid is False
    assert result.error == "KEY_NOT_FOUND"


def test_unsupported_key_type():
    signed, _, _, _ = _signed_with_jwks()
    jwks = {
        "keys": [
            {"kty": "RSA", "crv": "P-256", "kid": "k", "x": b64url_encode(b"\x00" * 32)}
        ]
    }
    result = verify_receipt(signed, jwks)
    assert result.valid is False
    assert result.error == "UNSUPPORTED_KEY_TYPE"


def test_invalid_key_length():
    signed, _, _, _ = _signed_with_jwks()
    jwks = {
        "keys": [
            {
                "kty": "OKP",
                "crv": "Ed25519",
                "kid": "k",
                "x": b64url_encode(b"\x00" * 31),
            }
        ]
    }
    result = verify_receipt(signed, jwks)
    assert result.valid is False
    assert result.error == "INVALID_KEY_LENGTH"


def test_invalid_signature_length():
    signed, jwks, _, _ = _signed_with_jwks()
    signed["signature"] = b64url_encode(b"\x00" * 63)
    result = verify_receipt(signed, jwks)
    assert result.valid is False
    assert result.error == "INVALID_SIGNATURE_LENGTH"


def test_invalid_signature():
    # Length stays 64; just flip a bit so the Ed25519 check fails.
    signed, jwks, _, _ = _signed_with_jwks()
    sig = bytearray(b64url_decode(signed["signature"]))
    sig[10] ^= 0xFF
    signed["signature"] = b64url_encode(bytes(sig))
    result = verify_receipt(signed, jwks)
    assert result.valid is False
    assert result.error == "INVALID_SIGNATURE"


def test_structural_error_raises():
    # Structural problems (missing required signed field) raise ValueError,
    # distinct from the six spec-defined verification errors.
    signed, jwks, _, _ = _signed_with_jwks()
    del signed["workspace_id"]
    with pytest.raises(ValueError, match="workspace_id"):
        verify_receipt(signed, jwks)


# ---------------------------------------------------------------------------
# Interop with jstibal/ors-spec examples
# ---------------------------------------------------------------------------

# GAP in jstibal/ors-spec: policy_classification.json is a v0.2 forward-compat
# example whose canonical_hash and signature are literal placeholder strings
# ("<sha256 of canonical payload>", "<base64url ed25519 signature>") rather
# than computed values. It cannot be used as a v0.1 interop vector. The other
# nine examples carry real (if illustratively-signed) canonical hashes.
_PLACEHOLDER_EXAMPLES = {"policy_classification.json"}


def _example_params():
    if not EXAMPLES_DIR.exists():
        return []
    params = []
    for p in sorted(EXAMPLES_DIR.glob("*.json")):
        if p.name in _PLACEHOLDER_EXAMPLES:
            params.append(
                pytest.param(
                    p,
                    marks=pytest.mark.skip(
                        reason=(
                            "Spec example contains literal placeholder "
                            "canonical_hash; not a real interop vector."
                        )
                    ),
                    id=p.name,
                )
            )
        else:
            params.append(pytest.param(p, id=p.name))
    return params


@pytest.mark.parametrize("example_path", _example_params())
def test_interop_canonical_hash_matches_example(example_path):
    """Canonicalization parity: our canonical_hash must equal the example's.

    This is the strongest interop claim we can make without JWKS material.
    """
    receipt = json.loads(example_path.read_text())
    payload = build_payload(receipt)
    computed = hashlib.sha256(canonicalize(payload)).hexdigest()
    assert computed == receipt["canonical_hash"], (
        f"{example_path.name}: canonical hash mismatch"
    )


@pytest.mark.skip(
    reason=(
        "GAP in jstibal/ors-spec: the example receipts contain illustrative "
        "signatures (the spec files literally say '_note: The signature is "
        "illustrative. Use verify.py with a live issuer JWKS to verify real "
        "receipts.') and the repo does not publish a JWKS document with the "
        "public keys for kid 'key_demo_01' etc. Without public keys, "
        "signature verification against the published examples is impossible. "
        "Canonical-hash interop is covered by "
        "test_interop_canonical_hash_matches_example. Re-enable this test "
        "when the spec publishes a JWKS alongside its examples."
    )
)
def test_interop_signature_verifies_against_spec_jwks():
    raise AssertionError("unreachable — skipped")
