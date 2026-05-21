# crewai-openterms

CrewAI adapter for [OpenTerms](https://github.com/jstibal/openterms-trace) — wraps any callable so each invocation emits a signed ORS v0.1 receipt before the tool runs.

Depends on [`openterms-py>=0.1.0`](https://pypi.org/project/openterms-py/) for canonicalization, signing, and the HTTP client. One signing path is shared with `langchain-openterms`.

## Install

```bash
pip install crewai-openterms
```

CrewAI itself is **not** a hard runtime dependency. CrewAI's `BaseTool` API has shifted repeatedly across the 0.x line (constructor signatures, the `_run`-vs-`run` hook, pydantic model versions), so this adapter wraps a plain callable — the function-tool pattern, which is stable across CrewAI versions. Plug the wrapped function into CrewAI however your project already does (`Tool(name=..., func=...)`, the `@tool` decorator, or as the body of a `BaseTool._run`).

## Quickstart

```python
from openterms import IngestClient, generate_keypair
from openterms_crewai import OpenTermsToolConfig, wrap_tool

sk, _ = generate_keypair()
client = IngestClient(
    base_url="http://localhost:3000",
    workspace_id="00000000-0000-4000-8000-0000000000aa",
    key_id="my-key",
    private_key=sk.private_bytes_raw(),
    agent_id="crew-agent",
)
config = OpenTermsToolConfig(
    client=client,
    agent_id="crew-agent",
    terms_url="https://example.com/terms",
    terms_hash="a" * 64,
    emit_post_action=True,
)

def search(query: str) -> str:
    """Pretend to look something up."""
    return f"results for: {query}"

wrapped_search = wrap_tool(search, config=config, tool_name="search")

# Plug into CrewAI:
#   from crewai.tools import Tool
#   tool = Tool(name="search", func=wrapped_search, description="...")
```

Decorator form:

```python
from openterms_crewai import openterms_tool

@openterms_tool(config, tool_name="search")
def search(query: str) -> str:
    return f"results for: {query}"
```

See [`examples/quickstart.py`](examples/quickstart.py) for a runnable copy.

## Configuration

`OpenTermsToolConfig` carries:

- `client` — the `openterms.IngestClient`.
- `agent_id` — placed on every receipt.
- `terms_url`, `terms_hash` — terms binding for the receipts.
- `emit_post_action` — when `True`, emit a second receipt after the tool returns with `post_state_hash` = SHA-256 of the stringified result. Default `False`.
- `strict` — when `True`, re-raise `openterms.IngestError`; default `False` (failures logged, tool still runs).

## What this adapter does

- Wraps a callable. Each invocation emits a signed ORS receipt with `action_type="tool_call"` and `action_context = {tool_id, args}`. Argument introspection is best-effort (`inspect.signature` first, positional fallback for builtins / C callables).
- Optionally emits a post-action receipt sharing the same `receipt_id` as the pre-action receipt.
- Logs and continues on ingest failures by default. The tool's return value is always passed through.

## What this adapter does NOT do

- **It does not depend on CrewAI at runtime.** Tests run without `crewai` installed. The wrapper is callable-based.
- **It does not run an ingest service.** You must point `IngestClient` at a running OpenTerms API.
- **It does not handle auth, host a JWKS, or manage keys.** See `openterms` for the underlying scope.
- **It does not buffer or retry.** A failed emission is logged once (or re-raised if `strict=True`).
- **It does not subclass CrewAI's `BaseTool`.** That subclass tends to break across CrewAI minor versions. If you need a `BaseTool` subclass, build one in your project that calls into a `wrap_tool`-produced callable from inside `_run`.

## Repository

Source and issue tracker: [`jstibal/openterms-trace`](https://github.com/jstibal/openterms-trace).

## License

Apache-2.0.
