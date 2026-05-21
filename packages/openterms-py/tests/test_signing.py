"""Round-trip and tamper tests for ORS v0.1 signing."""

from __future__ import annotations

import pytest

import hashlib

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from openterms._b64 import b64url_decode, b64url_encode
from openterms.canonical import DOMAIN_SEPARATOR, canonical_hash, canonicalize
from openterms.signing import (
    build_jwks,
    generate_keypair,
    public_key_to_jwk,
    sign_receipt,
)
from openterms.verification import verify_receipt


def _minimal_payload() -> dict:
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


def _full_payload() -> dict:
    payload = _minimal_payload()
    payload.update(
        {
            "ors_version": "0.1",
            "issuer": "https://issuer.example",
            "decision": "declined",
            "provider": {
                "origin": "https://api.example.com",
                "provider_id": "prov-123",
            },
            "request_binding": {
                "binding_method": "both",
                "provider_nonce": "nonce-xyz",
                "request_hash": "b" * 64,
                "expires_at": "2026-02-18T13:00:00.000Z",
            },
            "action_context": {
                "ors": {
                    "chain": {
                        "parent_receipt_id": "550e8400-e29b-41d4-a716-446655440001",
                        "chain_id": "chain_01HZYX",
                        "chain_depth": 2,
                        "originating_agent": "orchestrator-v1",
                    }
                },
                "request_id": "req-42",
            },
        }
    )
    return payload


def test_round_trip_minimal_payload():
    sk, pk = generate_keypair()
    jwks = build_jwks([(pk, "key_test_01")])

    signed = sign_receipt(_minimal_payload(), sk, "key_test_01")

    assert signed["canonical_hash"] == canonical_hash(_minimal_payload())
    assert signed["key_id"] == "key_test_01"
    assert len(b64url_decode(signed["signature"])) == 64

    result = verify_receipt(signed, jwks)
    assert result.valid is True
    assert result.error is None
    assert result.key_id == "key_test_01"


def test_round_trip_all_optional_fields():
    sk, pk = generate_keypair()
    jwks = build_jwks([(pk, "key_full")])

    signed = sign_receipt(_full_payload(), sk, "key_full")

    result = verify_receipt(signed, jwks)
    assert result.valid is True, result


def test_signing_is_deterministic():
    # Ed25519 (RFC 8032) signatures are deterministic for the same (key, message).
    sk, _ = generate_keypair()
    payload = _minimal_payload()
    a = sign_receipt(payload, sk, "k")
    b = sign_receipt(payload, sk, "k")
    assert a["signature"] == b["signature"]
    assert a["canonical_hash"] == b["canonical_hash"]


def test_signing_does_not_mutate_input():
    sk, _ = generate_keypair()
    payload = _minimal_payload()
    before = dict(payload)
    sign_receipt(payload, sk, "k")
    assert payload == before


def test_tampered_signature_fails_verification():
    sk, pk = generate_keypair()
    jwks = build_jwks([(pk, "k")])
    signed = sign_receipt(_minimal_payload(), sk, "k")

    sig = bytearray(b64url_decode(signed["signature"]))
    sig[0] ^= 0x01
    signed["signature"] = b64url_encode(bytes(sig))

    result = verify_receipt(signed, jwks)
    assert result.valid is False
    assert result.error == "INVALID_SIGNATURE"


def test_sign_rejects_metadata_in_input():
    sk, _ = generate_keypair()
    payload = _minimal_payload()
    payload["signature"] = "leaked"
    with pytest.raises(ValueError, match="signature metadata"):
        sign_receipt(payload, sk, "k")


def test_sign_accepts_raw_seed_bytes():
    sk, pk = generate_keypair()
    seed = sk.private_bytes_raw()
    jwks = build_jwks([(pk, "k")])
    signed = sign_receipt(_minimal_payload(), seed, "k")
    assert verify_receipt(signed, jwks).valid is True


def test_signs_raw_hash_bytes_not_hex_string() -> None:
    """Gate against an easy implementation regression.

    The Ed25519 signing input is ``DOMAIN_SEPARATOR || raw_sha256(canonical_bytes)``
    where the hash is 32 raw bytes. A common mistake is to sign the 64-character
    hex *string* of the hash instead. The two produce different signatures.
    Lock in the correct behavior by signing the expected bytes directly with
    the same key and asserting the production code matches.
    """
    sk, _ = generate_keypair()
    payload = _minimal_payload()
    canonical = canonicalize(payload)
    raw_hash = hashlib.sha256(canonical).digest()
    hex_hash = raw_hash.hex().encode("ascii")

    expected_message = DOMAIN_SEPARATOR + raw_hash
    wrong_message = DOMAIN_SEPARATOR + hex_hash

    sk_obj = sk if isinstance(sk, Ed25519PrivateKey) else Ed25519PrivateKey.from_private_bytes(sk)
    expected_sig = sk_obj.sign(expected_message)
    wrong_sig = sk_obj.sign(wrong_message)

    signed = sign_receipt(payload, sk, "k")
    produced_sig = b64url_decode(signed["signature"])

    assert produced_sig == expected_sig, (
        "sign_receipt must sign DOMAIN_SEPARATOR || raw_sha256(canonical_bytes)"
    )
    assert produced_sig != wrong_sig, (
        "sign_receipt must NOT sign the hex string of the hash"
    )


def test_public_key_to_jwk_shape():
    _, pk = generate_keypair()
    jwk = public_key_to_jwk(pk, "kid-1")
    assert jwk["kty"] == "OKP"
    assert jwk["crv"] == "Ed25519"
    assert jwk["use"] == "sig"
    assert jwk["kid"] == "kid-1"
    assert len(b64url_decode(jwk["x"])) == 32
