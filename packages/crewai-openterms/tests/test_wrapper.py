"""Unit tests for the CrewAI adapter."""

from __future__ import annotations

import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest
from openterms import IngestClient, IngestError, build_jwks, generate_keypair, verify_receipt

from openterms_crewai import OpenTermsToolConfig, openterms_tool, wrap_tool


class _Handler(BaseHTTPRequestHandler):
    server: _Server  # type: ignore[assignment]

    def log_message(self, *_args: Any) -> None:
        pass

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        receipt = json.loads(raw.decode("utf-8"))
        self.server.requests.append(receipt)
        body = json.dumps(
            {
                "hash": receipt["canonical_hash"],
                "ingested_at": "2026-05-20T00:00:00.000Z",
                "duplicate": False,
                "receipt": receipt,
            }
        ).encode("utf-8")
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class _Server(HTTPServer):
    requests: list[dict[str, Any]]


@pytest.fixture
def harness():
    sk, pk = generate_keypair()
    jwks = build_jwks([(pk, "ca-key")])
    httpd = _Server(("127.0.0.1", 0), _Handler)
    httpd.requests = []
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        port = httpd.server_address[1]
        client = IngestClient(
            base_url=f"http://127.0.0.1:{port}",
            workspace_id="44444444-4444-4444-4444-444444444444",
            key_id="ca-key",
            private_key=sk.private_bytes_raw(),
            agent_id="crew-agent",
        )
        config = OpenTermsToolConfig(
            client=client,
            agent_id="crew-agent",
            terms_url="https://example.com/terms",
            terms_hash="a" * 64,
        )
        yield {"config": config, "server": httpd, "jwks": jwks}
    finally:
        httpd.shutdown()
        thread.join(timeout=2)


def test_wrap_tool_emits_signed_receipt(harness):
    def add(a: int, b: int) -> int:
        return a + b

    wrapped = wrap_tool(add, config=harness["config"])
    assert wrapped(2, 3) == 5
    assert len(harness["server"].requests) == 1
    receipt = harness["server"].requests[0]
    assert receipt["action_type"] == "tool_call"
    assert receipt["action_context"]["tool_id"] == "add"
    assert receipt["action_context"]["args"] == {"a": 2, "b": 3}
    assert verify_receipt(receipt, harness["jwks"]).valid


def test_decorator_form(harness):
    @openterms_tool(harness["config"], tool_name="multiplier")
    def multiply(a: int, b: int) -> int:
        return a * b

    assert multiply(4, 5) == 20
    sent = harness["server"].requests[-1]
    assert sent["action_context"]["tool_id"] == "multiplier"


def test_post_action_receipt_emitted_when_enabled(harness):
    from dataclasses import replace

    config = replace(harness["config"], emit_post_action=True)

    def echo(s: str) -> str:
        return s

    wrapped = wrap_tool(echo, config=config)
    wrapped("hello")
    assert len(harness["server"].requests) == 2
    pre, post = harness["server"].requests
    assert pre["receipt_id"] == post["receipt_id"]
    assert (
        post["action_context"]["post_state_hash"]
        == hashlib.sha256(b"hello").hexdigest()
    )


def test_returns_underlying_result_even_if_ingest_fails():
    bad_client = IngestClient(
        base_url="http://127.0.0.1:1",  # nothing listening
        workspace_id="00000000-0000-0000-0000-000000000000",
        key_id="ca-key",
        private_key=bytes(32),
        agent_id="crew-agent",
        timeout=0.5,
    )
    config = OpenTermsToolConfig(
        client=bad_client,
        agent_id="crew-agent",
        terms_url="https://example.com/terms",
        terms_hash="b" * 64,
    )

    def echo(s: str) -> str:
        return s

    wrapped = wrap_tool(echo, config=config)
    # Should still return the underlying tool output despite ingest failure.
    assert wrapped("ok") == "ok"


def test_strict_mode_reraises():
    bad_client = IngestClient(
        base_url="http://127.0.0.1:1",
        workspace_id="00000000-0000-0000-0000-000000000000",
        key_id="ca-key",
        private_key=bytes(32),
        agent_id="crew-agent",
        timeout=0.5,
    )
    config = OpenTermsToolConfig(
        client=bad_client,
        agent_id="crew-agent",
        terms_url="https://example.com/terms",
        terms_hash="c" * 64,
        strict=True,
    )

    def echo(s: str) -> str:
        return s

    wrapped = wrap_tool(echo, config=config)
    with pytest.raises(IngestError):
        wrapped("ok")
