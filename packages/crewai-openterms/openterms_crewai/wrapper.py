"""Callable-level wrapper that emits a signed OpenTerms receipt per invocation.

Design rationale (see ``__init__.py`` for the CrewAI-API rationale): wrap a
plain callable. CrewAI versions disagree about ``BaseTool``'s exact shape, but
they all accept a function-shaped tool somewhere.

The wrapper is synchronous. CrewAI tools are synchronous in practice — even
when an LLM is involved upstream, tool execution is a synchronous Python call.
If async tools are needed later, add :func:`wrap_async_tool` alongside.
"""

from __future__ import annotations

import functools
import hashlib
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, TypeVar

from openterms import IngestClient, IngestError

_log = logging.getLogger(__name__)
T = TypeVar("T")


@dataclass(frozen=True)
class OpenTermsToolConfig:
    """Static config bundle for receipt emission around a tool call.

    Held separately from the wrapped callable so it can be reused across
    multiple tools in the same crew without re-passing every parameter.
    """

    client: IngestClient
    agent_id: str
    terms_url: str
    terms_hash: str
    emit_post_action: bool = False
    strict: bool = False


def wrap_tool(
    func: Callable[..., T],
    *,
    config: OpenTermsToolConfig,
    tool_name: str | None = None,
) -> Callable[..., T]:
    """Wrap ``func`` so each call emits an OpenTerms receipt.

    Parameters
    ----------
    func:
        The underlying tool implementation. Any callable.
    config:
        :class:`OpenTermsToolConfig` carrying the IngestClient, agent identity,
        and terms binding for receipts.
    tool_name:
        Display name placed in ``action_context.tool_id``. Defaults to
        ``func.__name__``.
    """
    name = tool_name or getattr(func, "__name__", "tool")

    @functools.wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> T:
        receipt_id = str(uuid.uuid4())
        action_context = {
            "tool_id": name,
            "args": _build_args(func, args, kwargs),
        }
        pre_canonical_hash: str | None = None
        try:
            resp = config.client.emit_receipt(
                action_type="tool_call",
                terms_url=config.terms_url,
                terms_hash=config.terms_hash,
                agent_id=config.agent_id,
                action_context=action_context,
                receipt_id=receipt_id,
            )
            pre_canonical_hash = resp.canonical_hash
        except IngestError as err:
            _log.warning("OpenTerms ingest failed before %s: %s", name, err)
            if config.strict:
                raise

        result = func(*args, **kwargs)

        if config.emit_post_action and pre_canonical_hash is not None:
            try:
                config.client.emit_post_action_receipt(
                    receipt_id=receipt_id,
                    post_state_hash=hashlib.sha256(str(result).encode("utf-8")).hexdigest(),
                    action_type="tool_call",
                    terms_url=config.terms_url,
                    terms_hash=config.terms_hash,
                    agent_id=config.agent_id,
                )
            except IngestError as err:
                _log.warning("OpenTerms ingest failed after %s: %s", name, err)
                if config.strict:
                    raise
        return result

    # Stash the canonical-hash side channel so callers (and tests) can correlate
    # the most recent invocation with the receipt that was emitted.
    wrapper.openterms_config = config  # type: ignore[attr-defined]
    return wrapper


def openterms_tool(
    config: OpenTermsToolConfig,
    *,
    tool_name: str | None = None,
) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """Decorator form of :func:`wrap_tool`.

    Example::

        @openterms_tool(config)
        def search(query: str) -> str:
            ...
    """

    def decorate(func: Callable[..., T]) -> Callable[..., T]:
        return wrap_tool(func, config=config, tool_name=tool_name)

    return decorate


def _build_args(
    func: Callable[..., Any], args: tuple[Any, ...], kwargs: dict[str, Any]
) -> dict[str, Any]:
    """Best-effort conversion of (args, kwargs) into a dict for action_context.

    Falls back to positional-name placeholders if introspection fails (e.g.
    builtins, C-extension callables, partials).
    """
    try:
        import inspect

        sig = inspect.signature(func)
        bound = sig.bind_partial(*args, **kwargs)
        return dict(bound.arguments)
    except (TypeError, ValueError):
        out: dict[str, Any] = {f"arg_{i}": v for i, v in enumerate(args)}
        out.update(kwargs)
        return out
