"""Tests for OpenTermsCallbackHandler.

Drives the handler through a fake LangChain tool invocation (calling
``on_tool_start`` / ``on_tool_end`` directly), backed by a stub HTTP server
that records every receipt that arrives. End-to-end LangChain integration
(running a real chain) is covered by the cross-package integration test.
"""

from __future__ import annotations

import hashlib
import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest
from openterms import IngestClient, IngestError, build_jwks, generate_keypair, verify_receipt

from openterms_langchain import OpenTermsCallbackHandler


class _Handler(BaseHTTPRequestHandler):
    server: _Server  # type: ignore[assignment]

    def log_message(self, *_args: Any) -> None:
        pass

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        receipt = json.loads(raw.decode("utf-8"))
        self.server.requests.append(receipt)
        response = {
            "hash": receipt["canonical_hash"],
            "ingested_at": "2026-05-20T00:00:00.000Z",
            "duplicate": False,
            "receipt": receipt,
        }
        body = json.dumps(response).encode("utf-8")
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
    jwks = build_jwks([(pk, "lc-key")])
    httpd = _Server(("127.0.0.1", 0), _Handler)
    httpd.requests = []
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        port = httpd.server_address[1]
        client = IngestClient(
            base_url=f"http://127.0.0.1:{port}",
            workspace_id="33333333-3333-3333-3333-333333333333",
            key_id="lc-key",
            private_key=sk.private_bytes_raw(),
            agent_id="lc-agent",
        )
        yield {"client": client, "server": httpd, "jwks": jwks}
    finally:
        httpd.shutdown()
        thread.join(timeout=2)


def test_tool_start_emits_signed_receipt(harness):
    handler = OpenTermsCallbackHandler(
        client=harness["client"],
        agent_id="lc-agent",
        terms_url="https://example.com/terms",
        terms_hash="a" * 64,
    )
    handler.on_tool_start(
        serialized={"name": "calculator"},
        input_str="2 + 2",
        run_id=uuid.uuid4(),
        inputs={"expression": "2 + 2"},
    )
    assert len(harness["server"].requests) == 1
    receipt = harness["server"].requests[0]
    assert receipt["action_type"] == "tool_call"
    assert receipt["action_context"]["tool_id"] == "calculator"
    assert receipt["action_context"]["args"] == {"expression": "2 + 2"}
    assert verify_receipt(receipt, harness["jwks"]).valid


def test_tool_end_emits_post_action_when_enabled(harness):
    handler = OpenTermsCallbackHandler(
        client=harness["client"],
        agent_id="lc-agent",
        terms_url="https://example.com/terms",
        terms_hash="b" * 64,
        emit_post_action=True,
    )
    run_id = uuid.uuid4()
    handler.on_tool_start(
        serialized={"name": "search"},
        input_str="cats",
        run_id=run_id,
        inputs={"query": "cats"},
    )
    handler.on_tool_end(output="result text", run_id=run_id)
    assert len(harness["server"].requests) == 2
    pre, post = harness["server"].requests
    assert pre["receipt_id"] == post["receipt_id"]  # same logical operation
    expected_hash = hashlib.sha256(b"result text").hexdigest()
    assert post["action_context"]["post_state_hash"] == expected_hash


def test_tool_end_without_post_action_does_not_emit(harness):
    handler = OpenTermsCallbackHandler(
        client=harness["client"],
        agent_id="lc-agent",
        terms_url="https://example.com/terms",
        terms_hash="c" * 64,
        emit_post_action=False,
    )
    run_id = uuid.uuid4()
    handler.on_tool_start(
        serialized={"name": "search"},
        input_str="cats",
        run_id=run_id,
    )
    handler.on_tool_end(output="x", run_id=run_id)
    assert len(harness["server"].requests) == 1


def test_per_tool_terms_override(harness):
    handler = OpenTermsCallbackHandler(
        client=harness["client"],
        agent_id="lc-agent",
        terms_url="https://example.com/default",
        terms_hash="d" * 64,
    )
    handler.set_tool_terms(
        "premium_tool",
        terms_url="https://example.com/premium",
        terms_hash="e" * 64,
    )
    handler.on_tool_start(
        serialized={"name": "premium_tool"},
        input_str="",
        run_id=uuid.uuid4(),
    )
    sent = harness["server"].requests[-1]
    assert sent["terms_url"] == "https://example.com/premium"
    assert sent["terms_hash"] == "e" * 64


def test_failure_is_swallowed_by_default(harness):
    # Point the client at a port nothing listens on; emit must not raise.
    bad_client = IngestClient(
        base_url="http://127.0.0.1:1",
        workspace_id="00000000-0000-0000-0000-000000000000",
        key_id="lc-key",
        private_key=bytes(32),
        agent_id="lc-agent",
        timeout=0.5,
    )
    handler = OpenTermsCallbackHandler(
        client=bad_client,
        agent_id="lc-agent",
        terms_url="https://example.com/terms",
        terms_hash="f" * 64,
    )
    # Must not raise.
    handler.on_tool_start(
        serialized={"name": "any"},
        input_str="",
        run_id=uuid.uuid4(),
    )


def test_strict_mode_reraises(harness):
    bad_client = IngestClient(
        base_url="http://127.0.0.1:1",
        workspace_id="00000000-0000-0000-0000-000000000000",
        key_id="lc-key",
        private_key=bytes(32),
        agent_id="lc-agent",
        timeout=0.5,
    )
    handler = OpenTermsCallbackHandler(
        client=bad_client,
        agent_id="lc-agent",
        terms_url="https://example.com/terms",
        terms_hash="0" * 64,
        strict=True,
    )
    with pytest.raises(IngestError):
        handler.on_tool_start(
            serialized={"name": "any"},
            input_str="",
            run_id=uuid.uuid4(),
        )


def test_emit_receipt_for_tool_helper(harness):
    handler = OpenTermsCallbackHandler(
        client=harness["client"],
        agent_id="lc-agent",
        terms_url="https://example.com/terms",
        terms_hash="1" * 64,
    )
    resp = handler.emit_receipt_for_tool(
        tool_name="calculator",
        inputs={"expression": "1+1"},
    )
    assert len(resp.canonical_hash) == 64
    assert harness["server"].requests[-1]["action_context"]["tool_id"] == "calculator"
