"""OpenTermsCallbackHandler — wraps LangChain tool calls in signed receipts.

For each tool invocation, the handler:

* on ``on_tool_start``  — builds + signs an ORS receipt with ``action_type``
  ``tool_call`` and ``action_context = {tool_id, args}``, POSTs to the
  ingest service, and records the canonical hash keyed by LangChain's
  ``run_id`` so :meth:`on_tool_end` can correlate.
* on ``on_tool_end`` (if ``emit_post_action=True``) — builds a second
  receipt whose ``action_context.post_state_hash`` is SHA-256 of the tool
  output, with the same ``receipt_id`` as the pre-action receipt.

Failure mode: if the ingest POST raises, the handler **logs and continues**.
A signing failure must not bring down the agent loop. Callers who need
strict-mode behavior can set ``strict=True`` to re-raise.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import uuid
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler
from openterms import IngestClient, IngestError, IngestResponse

_log = logging.getLogger(__name__)


@dataclass
class _PendingReceipt:
    receipt_id: str
    canonical_hash: str | None


class OpenTermsCallbackHandler(BaseCallbackHandler):
    """LangChain callback handler that emits OpenTerms receipts for tool calls.

    Parameters
    ----------
    client:
        Pre-built :class:`openterms.IngestClient`. The caller owns key custody;
        this handler only borrows the client to call ``emit_receipt``.
    agent_id:
        Identifier of the agent surface invoking tools (e.g. ``"acme-bot"``).
    terms_url, terms_hash:
        Defaults applied to every emitted receipt. May be overridden per
        tool via the ``terms`` argument to :meth:`set_tool_terms`.
    emit_post_action:
        When ``True``, emit a second receipt on ``on_tool_end`` carrying the
        post-action ``post_state_hash``.
    strict:
        When ``True``, re-raise :class:`openterms.IngestError` from the
        callback. Default ``False`` — failures are logged and swallowed so
        a misbehaving ingest does not break agent execution.
    """

    raise_error: bool = False

    def __init__(
        self,
        *,
        client: IngestClient,
        agent_id: str,
        terms_url: str,
        terms_hash: str,
        emit_post_action: bool = False,
        strict: bool = False,
    ) -> None:
        if not isinstance(client, IngestClient):
            raise TypeError("client must be an openterms.IngestClient")
        self._client = client
        self._agent_id = agent_id
        self._terms_url = terms_url
        self._terms_hash = terms_hash
        self._emit_post_action = emit_post_action
        self._strict = strict
        self._per_tool_terms: dict[str, dict[str, str]] = {}
        self._pending: dict[UUID, _PendingReceipt] = {}
        self._lock = threading.Lock()

    # ----- configuration -----

    def set_tool_terms(self, tool_name: str, *, terms_url: str, terms_hash: str) -> None:
        """Override terms_url + terms_hash for a specific tool by name."""
        self._per_tool_terms[tool_name] = {
            "terms_url": terms_url,
            "terms_hash": terms_hash,
        }

    # ----- LangChain hooks -----

    # LangChain 0.3 signature; ``serialized`` and ``input_str`` are required.
    # We accept **kwargs because optional positional args have shifted between
    # 0.1, 0.2, and 0.3 (e.g. ``inputs``, ``tags``, ``metadata``, ``run_id``).
    def on_tool_start(  # type: ignore[override]
        self,
        serialized: dict[str, Any],
        input_str: str,
        *,
        run_id: UUID | None = None,
        parent_run_id: UUID | None = None,  # noqa: ARG002 - LangChain API surface
        tags: list[str] | None = None,  # noqa: ARG002
        metadata: dict[str, Any] | None = None,  # noqa: ARG002
        inputs: dict[str, Any] | None = None,
        **kwargs: Any,  # noqa: ARG002
    ) -> None:
        tool_name = self._extract_tool_name(serialized)
        rid = run_id or uuid.uuid4()
        action_context = {
            "tool_id": tool_name,
            "args": inputs if inputs is not None else {"input": input_str},
        }
        terms = self._terms_for(tool_name)
        receipt_id = str(uuid.uuid4())
        try:
            resp = self._client.emit_receipt(
                action_type="tool_call",
                terms_url=terms["terms_url"],
                terms_hash=terms["terms_hash"],
                agent_id=self._agent_id,
                action_context=action_context,
                receipt_id=receipt_id,
            )
            with self._lock:
                self._pending[rid] = _PendingReceipt(
                    receipt_id=receipt_id, canonical_hash=resp.canonical_hash
                )
        except IngestError as err:
            _log.warning("OpenTerms ingest failed on tool_start for %s: %s", tool_name, err)
            with self._lock:
                self._pending[rid] = _PendingReceipt(receipt_id=receipt_id, canonical_hash=None)
            if self._strict:
                raise

    def on_tool_end(  # type: ignore[override]
        self,
        output: Any,
        *,
        run_id: UUID | None = None,
        parent_run_id: UUID | None = None,  # noqa: ARG002
        **kwargs: Any,  # noqa: ARG002
    ) -> None:
        if not self._emit_post_action:
            with self._lock:
                self._pending.pop(run_id, None) if run_id is not None else None
            return
        if run_id is None:
            return
        with self._lock:
            pending = self._pending.pop(run_id, None)
        if pending is None:
            return
        post_state_hash = hashlib.sha256(str(output).encode("utf-8")).hexdigest()
        # Use the pre-action receipt's tool name from the per-tool terms map if
        # we know it; otherwise fall back to defaults. Tool name isn't passed
        # to on_tool_end by LangChain, so default terms are the safe choice.
        try:
            self._client.emit_post_action_receipt(
                receipt_id=pending.receipt_id,
                post_state_hash=post_state_hash,
                action_type="tool_call",
                terms_url=self._terms_url,
                terms_hash=self._terms_hash,
                agent_id=self._agent_id,
            )
        except IngestError as err:
            _log.warning("OpenTerms ingest failed on tool_end: %s", err)
            if self._strict:
                raise

    def on_tool_error(  # type: ignore[override]
        self,
        error: BaseException,  # noqa: ARG002 - LangChain API surface
        *,
        run_id: UUID | None = None,
        parent_run_id: UUID | None = None,  # noqa: ARG002
        **kwargs: Any,  # noqa: ARG002
    ) -> None:
        # Drop the pending entry so we don't leak memory on long-running agents.
        if run_id is not None:
            with self._lock:
                self._pending.pop(run_id, None)

    # ----- helpers -----

    def emit_receipt_for_tool(
        self,
        *,
        tool_name: str,
        inputs: dict[str, Any],
    ) -> IngestResponse:
        """Synchronous helper for callers that wrap tools manually.

        Useful in environments where LangChain's callback machinery isn't in
        play (e.g. building a quickstart example without a full chain). Emits
        exactly one pre-action receipt and returns the response.
        """
        terms = self._terms_for(tool_name)
        return self._client.emit_receipt(
            action_type="tool_call",
            terms_url=terms["terms_url"],
            terms_hash=terms["terms_hash"],
            agent_id=self._agent_id,
            action_context={"tool_id": tool_name, "args": inputs},
        )

    def _terms_for(self, tool_name: str) -> dict[str, str]:
        override = self._per_tool_terms.get(tool_name)
        if override:
            return override
        return {"terms_url": self._terms_url, "terms_hash": self._terms_hash}

    @staticmethod
    def _extract_tool_name(serialized: dict[str, Any]) -> str:
        if not isinstance(serialized, dict):
            return "unknown_tool"
        # LangChain 0.3 puts the tool name at ``name``; earlier versions used
        # ``id[-1]``. Try ``name`` first and fall back.
        name = serialized.get("name")
        if isinstance(name, str) and name:
            return name
        ident = serialized.get("id")
        if isinstance(ident, list) and ident:
            return str(ident[-1])
        return "unknown_tool"
