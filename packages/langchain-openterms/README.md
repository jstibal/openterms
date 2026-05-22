# langchain-openterms

LangChain adapter for [OpenTerms](https://github.com/jstibal/openterms) — emits a signed ORS v0.1 receipt for every tool invocation in a LangChain chain or agent.

Depends on [`openterms-py>=0.1.0`](https://pypi.org/project/openterms-py/) for canonicalization, signing, and the HTTP client. One signing path is shared with `crewai-openterms`.

## Install

```bash
pip install langchain-openterms
```

This pulls in `langchain-core>=0.3,<1.0`. The adapter uses only the public `BaseCallbackHandler` hooks, which have been stable through the 0.3 line. If you need to run against an older LangChain version, pin `langchain-core` and report compatibility issues on the repo.

## Quickstart

```python
from langchain_core.tools import tool
from openterms import IngestClient, generate_keypair
from openterms_langchain import OpenTermsCallbackHandler

sk, _ = generate_keypair()
client = IngestClient(
    base_url="http://localhost:3000",
    workspace_id="00000000-0000-4000-8000-0000000000aa",
    key_id="my-key",
    private_key=sk.private_bytes_raw(),
    agent_id="my-agent",
)
handler = OpenTermsCallbackHandler(
    client=client,
    agent_id="my-agent",
    terms_url="https://example.com/terms",
    terms_hash="a" * 64,
    emit_post_action=True,
)

@tool
def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b

add.invoke({"a": 2, "b": 3}, config={"callbacks": [handler]})
```

Two receipts will be emitted per call: one on `on_tool_start` with the inputs, and one on `on_tool_end` with `action_context.post_state_hash` = SHA-256 of the output.

See [`examples/quickstart.py`](examples/quickstart.py) for a runnable copy.

## Configuration

- `terms_url` / `terms_hash`: the default terms binding for every receipt. Override per-tool with `handler.set_tool_terms(tool_name, terms_url=..., terms_hash=...)`.
- `emit_post_action`: when `True`, emit a second receipt on `on_tool_end`. Default `False`.
- `strict`: when `True`, re-raise `openterms.IngestError` from the callback so a failed emission propagates up the chain. Default `False` — failures are logged and swallowed so a misbehaving ingest cannot break an agent loop.

## What this adapter does

- Hooks LangChain's `on_tool_start` / `on_tool_end` / `on_tool_error` lifecycle.
- Builds an ORS receipt with `action_type="tool_call"` and `action_context = {tool_id, args}`.
- Signs and POSTs through `openterms.IngestClient`.
- Optionally emits a second receipt on tool completion containing a `post_state_hash` (SHA-256 of the stringified output).

## What this adapter does NOT do

- **It does not run an ingest service.** You must point `IngestClient` at a running OpenTerms API. See [`apps/api`](https://github.com/jstibal/openterms/tree/main/apps/api) and [IMPLEMENTATION_STATUS.md](https://github.com/jstibal/openterms/blob/main/IMPLEMENTATION_STATUS.md).
- **It does not handle auth.** The bearer-token placeholder on `IngestClient` is not yet enforced by the service.
- **It does not host a JWKS.** Verification requires a JWKS you supply.
- **It does not buffer or retry.** A failed emission is logged once (or re-raised if `strict=True`) and the call proceeds.
- **It does not patch LangChain.** The handler is purely additive — you attach it via the `callbacks` config argument and remove it the same way.

## Repository

Source and issue tracker: [`jstibal/openterms`](https://github.com/jstibal/openterms).

## License

Apache-2.0.
