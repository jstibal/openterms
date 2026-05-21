# Run from the repo root with the openterms-py venv active:
# source packages/openterms-py/.venv/bin/activate && python scripts/generate-staging-keypair.py
"""Generate an Ed25519 keypair for the Render staging deployment.

Prints ACTIVE_KEY_ID, PRIVATE_KEY_JWK, and JWKS_SOURCE on three single lines
suitable for copy/paste into Render env vars. The generated values are
secrets — do NOT commit the output.
"""

from __future__ import annotations

import json
import secrets

from cryptography.hazmat.primitives import serialization

from openterms._b64 import b64url_encode
from openterms.signing import build_jwks, generate_keypair, public_key_to_jwk
from openterms.verification import verify_receipt
from openterms.signing import sign_receipt


def private_key_to_jwk(private_key, public_jwk: dict) -> dict:
    seed = private_key.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return {
        "kty": "OKP",
        "crv": "Ed25519",
        "x": public_jwk["x"],
        "d": b64url_encode(seed),
        "kid": public_jwk["kid"],
        "use": "sig",
    }


def main() -> None:
    sk, pk = generate_keypair()
    kid = "ot-staging-" + secrets.token_hex(4)

    public_jwk = public_key_to_jwk(pk, kid)
    private_jwk = private_key_to_jwk(sk, public_jwk)
    jwks = build_jwks([(pk, kid)])

    private_jwk_line = json.dumps(private_jwk, separators=(",", ":"))
    jwks_line = json.dumps(jwks, separators=(",", ":"))
    jwks_source = "memory:" + jwks_line

    # Self-check: parse JWKS_SOURCE, sign a sample receipt, verify it.
    assert jwks_source.startswith("memory:")
    parsed_jwks = json.loads(jwks_source[len("memory:"):])
    sample_payload = {
        "workspace_id": "ws_staging",
        "agent_id": "agent_staging",
        "action_type": "test",
        "terms_url": "https://example.com/terms",
        "terms_hash": "0" * 64,
        "timestamp": "2026-05-21T00:00:00Z",
        "pricing_version": "v1",
        "receipt_id": "rcpt_staging_selfcheck",
        "amount_charged": "0",
        "created_at": "2026-05-21T00:00:00Z",
    }
    signed = sign_receipt(sample_payload, sk, kid)
    result = verify_receipt(signed, parsed_jwks)
    if not result.valid:
        raise SystemExit(f"verification self-check failed: {result.error}")

    print(f"ACTIVE_KEY_ID: {kid}")
    print(f"PRIVATE_KEY_JWK: {private_jwk_line}")
    print(f"JWKS_SOURCE: {jwks_source}")


if __name__ == "__main__":
    main()
