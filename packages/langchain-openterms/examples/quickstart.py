"""LangChain quickstart for openterms-langchain.

Demonstrates a single LangChain tool wrapped in OpenTermsCallbackHandler.
Every invocation produces a signed ORS v0.1 receipt POSTed to the configured
ingest URL.

Prerequisites
-------------
* A running OpenTerms API service. Spin one up locally with:

    cd apps/api
    npm run dev    # listens on http://localhost:3000

* The workspace_id below must match ``WORKSPACE_ID`` on the service.
* A signing key registered in the service JWKS. For local development the
  service loads JWKS from a ``file:`` or ``memory:`` URI (see
  IMPLEMENTATION_STATUS.md → "Authentication"); a hosted
  ``/.well-known/jwks.json`` will not be available until BUILD_BRIEF Step 10.

Run
---
    python examples/quickstart.py
"""

from __future__ import annotations

import os
import uuid

from langchain_core.tools import tool
from openterms import IngestClient, generate_keypair

from openterms_langchain import OpenTermsCallbackHandler


def main() -> None:
    base_url = os.environ.get("OPENTERMS_INGEST_URL", "http://localhost:3000")
    workspace_id = os.environ.get(
        "OPENTERMS_WORKSPACE_ID",
        "00000000-0000-4000-8000-0000000000aa",
    )
    key_id = os.environ.get("OPENTERMS_KEY_ID", "quickstart-key")

    # For a real deployment, load your private key from a secure store and
    # register the public key in the workspace JWKS. Here we generate a
    # disposable one for illustration — receipts will not verify against the
    # service's JWKS unless the public key was registered first.
    sk, _ = generate_keypair()
    private_seed = sk.private_bytes_raw()

    client = IngestClient(
        base_url=base_url,
        workspace_id=workspace_id,
        key_id=key_id,
        private_key=private_seed,
        agent_id="quickstart-agent",
    )

    handler = OpenTermsCallbackHandler(
        client=client,
        agent_id="quickstart-agent",
        terms_url="https://example.com/terms",
        terms_hash="a" * 64,
        emit_post_action=True,
    )

    @tool
    def add(a: int, b: int) -> int:
        """Add two integers."""
        return a + b

    # Invoke the tool with the callback handler attached. Two receipts will be
    # emitted: one on tool start (with inputs) and one on tool end (with the
    # SHA-256 of the output as ``post_state_hash``).
    result = add.invoke({"a": 2, "b": 3}, config={"callbacks": [handler], "run_id": uuid.uuid4()})
    print(f"tool result: {result}")


if __name__ == "__main__":
    main()
