"""ORS v0.1 signing (Section 6) and JWKS construction helpers (Section 7).

Signing is pure Ed25519 (RFC 8032) over the 40-byte domain-separated message
``ORSv0.1\\x00`` + raw SHA-256(canonical_bytes). The cryptography library is
used to match the reference verifier in jstibal/ors-spec.
"""

from __future__ import annotations

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from ._b64 import b64url_encode
from .canonical import (
    PAYLOAD_KEYS_OPTIONAL,
    PAYLOAD_KEYS_REQUIRED,
    PAYLOAD_KEYS_SIGNED_ENVELOPE,
    canonical_hash,
    signing_input,
)

PrivateKeyInput = Ed25519PrivateKey | bytes

_SIGNED_KEYS = set(PAYLOAD_KEYS_REQUIRED) | set(PAYLOAD_KEYS_SIGNED_ENVELOPE) | set(
    PAYLOAD_KEYS_OPTIONAL
)
_METADATA_KEYS = {"canonical_hash", "signature", "key_id"}


def _coerce_private_key(private_key: PrivateKeyInput) -> Ed25519PrivateKey:
    if isinstance(private_key, Ed25519PrivateKey):
        return private_key
    if isinstance(private_key, (bytes, bytearray)):
        if len(private_key) != 32:
            raise ValueError(
                f"Ed25519 private key seed must be 32 bytes, got {len(private_key)}"
            )
        return Ed25519PrivateKey.from_private_bytes(bytes(private_key))
    raise TypeError(
        "private_key must be Ed25519PrivateKey or 32-byte seed, "
        f"got {type(private_key).__name__}"
    )


def sign_receipt(
    payload: dict,
    private_key: PrivateKeyInput,
    key_id: str,
) -> dict:
    """Sign a payload and return a new receipt dict.

    ``payload`` MUST contain only signed fields (Section 3a required + optional
    + Section 3b signed envelope). The Section 3c outputs (``canonical_hash``,
    ``signature``, ``key_id``) MUST NOT be present in the input — they are
    populated by this function. This is a defensive check: those keys are
    outputs of signing, never inputs.
    """
    if not isinstance(payload, dict):
        raise TypeError("payload must be a dict")
    if not isinstance(key_id, str) or not key_id:
        raise ValueError("key_id must be a non-empty string")

    leaked = _METADATA_KEYS & payload.keys()
    if leaked:
        raise ValueError(
            f"payload must not contain signature metadata keys: {sorted(leaked)}"
        )
    unknown = payload.keys() - _SIGNED_KEYS
    if unknown:
        raise ValueError(f"payload contains unknown keys: {sorted(unknown)}")

    sk = _coerce_private_key(private_key)
    message = signing_input(payload)
    signature = sk.sign(message)

    signed = dict(payload)
    signed["canonical_hash"] = canonical_hash(payload)
    signed["signature"] = b64url_encode(signature)
    signed["key_id"] = key_id
    return signed


def generate_keypair() -> tuple[Ed25519PrivateKey, Ed25519PublicKey]:
    """Generate a fresh Ed25519 keypair. For tests and dev only."""
    sk = Ed25519PrivateKey.generate()
    return sk, sk.public_key()


def public_key_to_jwk(public_key: Ed25519PublicKey, kid: str) -> dict:
    """Return a JWK (RFC 7517) for an Ed25519 public key."""
    raw = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return {
        "kty": "OKP",
        "crv": "Ed25519",
        "x": b64url_encode(raw),
        "kid": kid,
        "use": "sig",
    }


def build_jwks(keys: list[tuple[Ed25519PublicKey, str]]) -> dict:
    """Construct a JWKS document from (public_key, kid) pairs."""
    return {"keys": [public_key_to_jwk(pk, kid) for pk, kid in keys]}
