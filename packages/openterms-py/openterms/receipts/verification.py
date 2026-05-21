"""ORS v0.1 verification (Section 8).

Implements the six structured error codes from the spec pseudocode:
  HASH_MISMATCH, KEY_NOT_FOUND, UNSUPPORTED_KEY_TYPE,
  INVALID_KEY_LENGTH, INVALID_SIGNATURE_LENGTH, INVALID_SIGNATURE.

JWKS is passed as an in-memory dict. Transport (HTTP fetch, file load) is the
caller's job; verification is pure.

Error precedence matches the reference verifier order: hash → key lookup →
kty/crv → key length → sig length → signature verify. ``INVALID_KEY_LENGTH``
and ``INVALID_SIGNATURE_LENGTH`` are *returned* (matching the spec §8
pseudocode), where the reference verify.py *raises* them — a deliberate
divergence so all six error codes are testable through the same surface.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from ._b64 import b64url_decode
from .canonical import DOMAIN_SEPARATOR, build_payload, canonicalize


@dataclass(frozen=True)
class VerifyResult:
    valid: bool
    error: str | None = None
    key_id: str | None = None
    canonical_hash: str | None = None


def _fail(error: str, key_id: str | None, computed_hash: str | None) -> VerifyResult:
    return VerifyResult(
        valid=False, error=error, key_id=key_id, canonical_hash=computed_hash
    )


def verify_receipt(receipt: dict, jwks: dict) -> VerifyResult:
    """Verify an ORS v0.1 receipt against a JWKS dict."""
    if "canonical_hash" not in receipt:
        raise ValueError("Missing required signature metadata field: canonical_hash")
    if "signature" not in receipt:
        raise ValueError("Missing required signature metadata field: signature")
    if "key_id" not in receipt:
        raise ValueError("Missing required signature metadata field: key_id")

    key_id = receipt["key_id"]
    payload = build_payload(receipt)
    canonical_bytes = canonicalize(payload)
    hash_bytes = hashlib.sha256(canonical_bytes).digest()
    hash_hex = hash_bytes.hex()

    if hash_hex != receipt["canonical_hash"]:
        return _fail("HASH_MISMATCH", key_id, hash_hex)

    jwk = None
    for k in jwks.get("keys", []):
        if k.get("kid") == key_id:
            jwk = k
            break
    if jwk is None:
        return _fail("KEY_NOT_FOUND", key_id, hash_hex)

    if jwk.get("kty") != "OKP" or jwk.get("crv") != "Ed25519":
        return _fail("UNSUPPORTED_KEY_TYPE", key_id, hash_hex)

    try:
        pub_bytes = b64url_decode(jwk["x"])
    except (KeyError, ValueError):
        return _fail("INVALID_KEY_LENGTH", key_id, hash_hex)
    if len(pub_bytes) != 32:
        return _fail("INVALID_KEY_LENGTH", key_id, hash_hex)

    try:
        sig_bytes = b64url_decode(receipt["signature"])
    except ValueError:
        return _fail("INVALID_SIGNATURE_LENGTH", key_id, hash_hex)
    if len(sig_bytes) != 64:
        return _fail("INVALID_SIGNATURE_LENGTH", key_id, hash_hex)

    message = DOMAIN_SEPARATOR + hash_bytes
    try:
        Ed25519PublicKey.from_public_bytes(pub_bytes).verify(sig_bytes, message)
    except InvalidSignature:
        return _fail("INVALID_SIGNATURE", key_id, hash_hex)

    return VerifyResult(
        valid=True, error=None, key_id=key_id, canonical_hash=hash_hex
    )
