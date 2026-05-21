"""ORS v0.1 receipts — sign, verify, canonicalize, JWKS helpers.

This submodule replaces the 0.4.x ``openterms.receipts`` namespace (which
shipped PyNaCl-based ``sign_receipt`` / ``verify_receipt`` helpers for the
permission-lookup half). The function names survive but their signatures
and semantics have changed — see CHANGELOG.md "Silent breaking changes".
"""

from .canonical import (
    DOMAIN_SEPARATOR,
    CanonicalizationError,
    build_payload,
    canonical_hash,
    canonicalize,
    signing_input,
    strip_nulls,
)
from .signing import build_jwks, generate_keypair, public_key_to_jwk, sign_receipt
from .verification import VerifyResult, verify_receipt

__all__ = [
    "DOMAIN_SEPARATOR",
    "CanonicalizationError",
    "VerifyResult",
    "build_jwks",
    "build_payload",
    "canonical_hash",
    "canonicalize",
    "generate_keypair",
    "public_key_to_jwk",
    "sign_receipt",
    "signing_input",
    "strip_nulls",
    "verify_receipt",
]
