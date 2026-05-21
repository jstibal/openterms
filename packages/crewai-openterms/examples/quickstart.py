"""CrewAI quickstart for openterms-crewai.

Wraps a single function in :func:`openterms_crewai.wrap_tool` and demonstrates
that each invocation produces a signed ORS v0.1 receipt POSTed to the
configured ingest URL.

This example does NOT spin up a full CrewAI crew — the adapter operates at the
callable level, so the integration is identical whether you hand the wrapped
function to :class:`crewai.tools.Tool`, to ``@tool`` from
``crewai.tools``, or to a custom ``BaseTool._run``.

Prerequisites
-------------
* A running OpenTerms API service. See ``apps/api/README.md``.
* A signing key whose public half is in the workspace JWKS (see
  ``IMPLEMENTATION_STATUS.md`` for the local-development JWKS setup).
* Optional: ``pip install crewai`` if you want to plug the wrapper into a
  real crew. The adapter itself does not require CrewAI to be installed.

Run
---
    python examples/quickstart.py
"""

from __future__ import annotations

import os

from openterms import IngestClient, generate_keypair

from openterms_crewai import OpenTermsToolConfig, wrap_tool


def main() -> None:
    base_url = os.environ.get("OPENTERMS_INGEST_URL", "http://localhost:3000")
    workspace_id = os.environ.get(
        "OPENTERMS_WORKSPACE_ID",
        "00000000-0000-4000-8000-0000000000aa",
    )
    key_id = os.environ.get("OPENTERMS_KEY_ID", "quickstart-key")

    sk, _ = generate_keypair()
    private_seed = sk.private_bytes_raw()

    client = IngestClient(
        base_url=base_url,
        workspace_id=workspace_id,
        key_id=key_id,
        private_key=private_seed,
        agent_id="crew-quickstart",
    )
    config = OpenTermsToolConfig(
        client=client,
        agent_id="crew-quickstart",
        terms_url="https://example.com/terms",
        terms_hash="a" * 64,
        emit_post_action=True,
    )

    def search(query: str) -> str:
        """Pretend to look something up."""
        return f"results for: {query}"

    wrapped_search = wrap_tool(search, config=config, tool_name="search")

    # Plug into CrewAI like so (uncomment if CrewAI is installed):
    #
    #     from crewai.tools import Tool
    #     tool = Tool(name="search", func=wrapped_search, description="…")
    #
    # Or via the @tool decorator pattern. Either way, every invocation of
    # wrapped_search will emit a signed receipt before delegating.
    print(wrapped_search(query="hello"))


if __name__ == "__main__":
    main()
