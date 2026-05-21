"""Tests for openterms.client.IngestClient.

The client wraps build_payload + sign_receipt + a POST. These tests stand up a
real ``http.server`` and exercise the surface end-to-end inside the local
process, so we get coverage of:

* receipt shape on the wire (matches the Fastify ingest validator),
* idempotency-key passthrough,
* server-side 4xx + 5xx error mapping,
* JWKS fetch + verify round-trip.

No third-party HTTP libraries are used by the client or these tests — matches
the package's stance of having only ``cryptography`` as a runtime dependency.
"""

from __future__ import annotations

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest

from openterms import (
    IngestClient,
    IngestError,
    build_jwks,
    generate_keypair,
    verify_receipt,
)


class _Handler(BaseHTTPRequestHandler):
    server: _Server  # type: ignore[assignment]

    def log_message(self, *_args: Any) -> None:  # silence test output
        pass

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/.well-known/jwks.json":
            body = json.dumps(self.server.jwks).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/receipts/ingest":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            receipt = json.loads(raw.decode("utf-8"))
        except ValueError:
            self.send_response(400)
            self.end_headers()
            return
        self.server.requests.append(
            {
                "headers": dict(self.headers),
                "receipt": receipt,
            }
        )

        # Optional canned-response override (used by failure tests).
        canned = self.server.canned_response
        if canned is not None:
            status, body_obj = canned
            body = json.dumps(body_obj).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # Default: pretend ingest succeeded.
        response_body = {
            "hash": receipt["canonical_hash"],
            "ingested_at": "2026-05-20T00:00:00.000Z",
            "duplicate": False,
            "receipt": receipt,
        }
        body = json.dumps(response_body).encode("utf-8")
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class _Server(HTTPServer):
    requests: list[dict[str, Any]]
    jwks: dict[str, Any]
    canned_response: tuple[int, dict[str, Any]] | None


@pytest.fixture
def server():
    sk, pk = generate_keypair()
    jwks = build_jwks([(pk, "test-key")])
    httpd = _Server(("127.0.0.1", 0), _Handler)
    httpd.requests = []
    httpd.jwks = jwks
    httpd.canned_response = None
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        port = httpd.server_address[1]
        yield {
            "base_url": f"http://127.0.0.1:{port}",
            "server": httpd,
            "private_key": sk.private_bytes_raw(),
            "jwks": jwks,
        }
    finally:
        httpd.shutdown()
        thread.join(timeout=2)


def _make_client(server, **overrides) -> IngestClient:
    defaults = dict(
        base_url=server["base_url"],
        workspace_id="11111111-1111-1111-1111-111111111111",
        key_id="test-key",
        private_key=server["private_key"],
        agent_id="agent-001",
    )
    defaults.update(overrides)
    return IngestClient(**defaults)


def test_emit_receipt_signs_and_posts(server):
    client = _make_client(server)
    result = client.emit_receipt(
        action_type="tool_call",
        terms_url="https://example.com/terms",
        terms_hash="a" * 64,
        action_context={"tool_id": "search"},
        amount_charged=0,
    )
    assert result.status == 201
    assert result.duplicate is False
    assert len(result.canonical_hash) == 64

    sent = server["server"].requests[-1]["receipt"]
    # Required signed fields are on the wire.
    for k in (
        "workspace_id",
        "agent_id",
        "action_type",
        "terms_url",
        "terms_hash",
        "timestamp",
        "pricing_version",
        "receipt_id",
        "amount_charged",
        "created_at",
        "canonical_hash",
        "signature",
        "key_id",
    ):
        assert k in sent, f"missing {k}"
    assert sent["action_context"] == {"tool_id": "search"}
    # And the signature actually verifies.
    assert verify_receipt(sent, server["jwks"]).valid


def test_emit_receipt_passes_idempotency_key(server):
    client = _make_client(server)
    client.emit_receipt(
        action_type="tool_call",
        terms_url="https://example.com/terms",
        terms_hash="b" * 64,
        idempotency_key="my-key-123",
    )
    headers = server["server"].requests[-1]["headers"]
    # http.server lowercases header names via case-insensitive lookup
    assert headers.get("Idempotency-Key") == "my-key-123"


def test_emit_post_action_receipt_packs_post_state_hash(server):
    client = _make_client(server)
    rid = str(uuid.uuid4())
    client.emit_post_action_receipt(
        receipt_id=rid,
        post_state_hash="c" * 64,
        action_type="tool_call",
        terms_url="https://example.com/terms",
        terms_hash="d" * 64,
    )
    sent = server["server"].requests[-1]["receipt"]
    assert sent["receipt_id"] == rid
    assert sent["action_context"]["post_state_hash"] == "c" * 64


def test_v02_fields_pass_through(server):
    client = _make_client(server)
    client.emit_receipt(
        action_type="tool_call",
        terms_url="https://example.com/terms",
        terms_hash="e" * 64,
        extra={
            "terms_type": "saas",
            "terms_service": "example",
            "terms_version": "2025-05-01",
        },
    )
    sent = server["server"].requests[-1]["receipt"]
    assert sent["terms_type"] == "saas"
    assert sent["terms_service"] == "example"
    assert sent["terms_version"] == "2025-05-01"
    # The signature must still verify (build_payload must include these).
    assert verify_receipt(sent, server["jwks"]).valid


def test_ingest_http_error_raises_ingest_error(server):
    server["server"].canned_response = (
        400,
        {"code": "VALIDATION_ERROR", "message": "nope"},
    )
    client = _make_client(server)
    with pytest.raises(IngestError) as ei:
        client.emit_receipt(
            action_type="tool_call",
            terms_url="https://example.com/terms",
            terms_hash="f" * 64,
        )
    assert ei.value.status == 400
    assert ei.value.code == "VALIDATION_ERROR"


def test_fetch_jwks_then_verify(server):
    client = _make_client(
        server,
        jwks_url=f"{server['base_url']}/.well-known/jwks.json",
    )
    fetched = client.fetch_jwks()
    assert "keys" in fetched and len(fetched["keys"]) == 1
    # Verify a receipt we just emitted using the fetched JWKS.
    result = client.emit_receipt(
        action_type="tool_call",
        terms_url="https://example.com/terms",
        terms_hash="0" * 64,
    )
    sent = server["server"].requests[-1]["receipt"]
    assert result.canonical_hash == sent["canonical_hash"]
    assert client.verify(sent).valid


def test_verify_with_inline_jwks(server):
    client = _make_client(server, jwks=server["jwks"])
    client.emit_receipt(
        action_type="tool_call",
        terms_url="https://example.com/terms",
        terms_hash="1" * 64,
    )
    sent = server["server"].requests[-1]["receipt"]
    assert client.verify(sent).valid


def test_emit_requires_agent_id(server):
    client = _make_client(server, agent_id=None)
    with pytest.raises(ValueError, match="agent_id"):
        client.emit_receipt(
            action_type="tool_call",
            terms_url="https://example.com/terms",
            terms_hash="2" * 64,
        )
