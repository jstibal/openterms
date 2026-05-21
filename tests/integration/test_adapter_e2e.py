"""End-to-end adapter integration test.

Demonstrates the full BUILD_BRIEF Step 8 chain:

    openterms-langchain (callback) → openterms.IngestClient (sign + POST)
       → apps/api Fastify ingest (verify + store)
       → GET /v1/receipts (query)
       → openterms.verify_receipt (offline re-verify)

Reuses the ``server_env`` session fixture in ``conftest.py`` so the same
Fastify + Postgres pair backs both this test and ``test_ingest_e2e.py``.

Skipped automatically if Postgres client tools are not on PATH (handled by the
shared fixture).
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
import uuid

from openterms import IngestClient, verify_receipt
from openterms_langchain import OpenTermsCallbackHandler


def _client(server_env) -> IngestClient:
    return IngestClient(
        base_url=server_env["base_url"],
        workspace_id=server_env["workspace_id"],
        key_id=server_env["kid"],
        private_key=server_env["seed"],
        agent_id="adapter-e2e",
    )


def test_langchain_handler_end_to_end(server_env):
    client = _client(server_env)
    handler = OpenTermsCallbackHandler(
        client=client,
        agent_id="adapter-e2e",
        terms_url="https://example.com/terms",
        terms_hash="a" * 64,
        emit_post_action=True,
    )

    run_id = uuid.uuid4()
    handler.on_tool_start(
        serialized={"name": "search"},
        input_str="OpenTerms receipts",
        run_id=run_id,
        inputs={"query": "OpenTerms receipts"},
    )
    handler.on_tool_end(output="3 results found", run_id=run_id)

    # Query the service to confirm both receipts (pre- and post-action) are stored.
    qs = urllib.parse.urlencode({"agent_id": "adapter-e2e", "limit": 10})
    with urllib.request.urlopen(f"{server_env['base_url']}/v1/receipts?{qs}") as resp:
        body = json.loads(resp.read())

    receipts = body["items"] if "items" in body else body.get("receipts", [])
    assert len(receipts) == 2, f"expected 2 receipts, got {len(receipts)}: {receipts}"

    # Both receipts must re-verify against the workspace JWKS using the offline
    # Python verifier. This is the contract from BUILD_BRIEF Step 8:
    # "Receipts emitted by each SDK verify successfully through the ORS Python
    # verifier."
    for item in receipts:
        receipt = item.get("receipt") or item
        result = verify_receipt(receipt, server_env["jwks"])
        assert result.valid, f"receipt failed re-verify: {result.error}"


def test_crewai_wrapper_end_to_end(server_env):
    from openterms_crewai import OpenTermsToolConfig, wrap_tool

    client = _client(server_env)
    config = OpenTermsToolConfig(
        client=client,
        agent_id="crewai-e2e",
        terms_url="https://example.com/terms",
        terms_hash="b" * 64,
    )

    def search(query: str) -> str:
        return f"results for {query}"

    wrapped = wrap_tool(search, config=config, tool_name="search")
    result = wrapped(query="hello")
    assert result == "results for hello"

    qs = urllib.parse.urlencode({"agent_id": "crewai-e2e", "limit": 5})
    with urllib.request.urlopen(f"{server_env['base_url']}/v1/receipts?{qs}") as resp:
        body = json.loads(resp.read())
    receipts = body["items"] if "items" in body else body.get("receipts", [])
    assert len(receipts) == 1
    receipt = receipts[0].get("receipt") or receipts[0]
    assert verify_receipt(receipt, server_env["jwks"]).valid
