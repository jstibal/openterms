"""Session-scoped fixtures for the cross-language ingest integration tests.

Boots a real Postgres database and a real Node Fastify server, and tears them
down at session exit. The test runs end-to-end:

    openterms-py (sign) → HTTP → apps/api/dist/server.js → Postgres

so any drift between the Python SDK and the TypeScript service shows up as a
real verification or storage failure rather than a contract mismatch caught at
the schema level.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
API_DIR = REPO_ROOT / "apps" / "api"
SERVER_ENTRY = API_DIR / "dist" / "server.js"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _b64url(b: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _ensure_built() -> None:
    if not SERVER_ENTRY.exists():
        # Build on demand so the test still works after a clean checkout.
        subprocess.run(["npx", "tsc", "-p", "tsconfig.json"], cwd=API_DIR, check=True)


def _create_db(db_name: str) -> str:
    subprocess.run(
        ["dropdb", "--if-exists", db_name],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(["createdb", db_name], check=True)
    return f"postgres://localhost:5432/{db_name}"


def _drop_db(db_name: str) -> None:
    subprocess.run(
        ["dropdb", "--if-exists", db_name],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _wait_healthy(base_url: str, timeout_s: float = 15.0) -> None:
    deadline = time.monotonic() + timeout_s
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{base_url}/healthz", timeout=1) as resp:
                if resp.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError) as e:
            last_err = e
        time.sleep(0.15)
    raise RuntimeError(f"server did not become healthy at {base_url}: {last_err}")


@pytest.fixture(scope="session")
def server_env(tmp_path_factory: pytest.TempPathFactory):
    if not shutil.which("createdb"):
        pytest.skip("Postgres client tools (createdb/dropdb) not on PATH")

    _ensure_built()

    db_name = f"openterms_test_{uuid.uuid4().hex[:12]}"
    db_url = _create_db(db_name)

    # Fresh keypair + JWKS for this session.
    sk = Ed25519PrivateKey.generate()
    pk = sk.public_key()
    seed = sk.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub_raw = pk.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    kid = "test-key-1"
    jwks = {"keys": [{"kty": "OKP", "crv": "Ed25519", "kid": kid, "x": _b64url(pub_raw), "use": "sig"}]}

    tmp = tmp_path_factory.mktemp("ingest")
    jwks_path = tmp / "jwks.json"
    jwks_path.write_text(json.dumps(jwks))

    workspace_id = "00000000-0000-4000-8000-000000000001"
    port = _free_port()
    env = {
        **os.environ,
        "DATABASE_URL": db_url,
        "JWKS_SOURCE": f"file:{jwks_path}",
        "WORKSPACE_ID": workspace_id,
        "PORT": str(port),
        "LOG_LEVEL": "error",
    }
    proc = subprocess.Popen(
        ["node", str(SERVER_ENTRY)],
        cwd=API_DIR,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        _wait_healthy(base_url)
    except Exception:
        proc.terminate()
        try:
            out = proc.communicate(timeout=2)[0].decode(errors="replace")
        except subprocess.TimeoutExpired:
            proc.kill()
            out = ""
        _drop_db(db_name)
        sys.stderr.write(f"server log:\n{out}\n")
        raise

    yield {
        "base_url": base_url,
        "db_url": db_url,
        "db_name": db_name,
        "workspace_id": workspace_id,
        "seed": seed,
        "kid": kid,
        "jwks": jwks,
    }

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    _drop_db(db_name)
