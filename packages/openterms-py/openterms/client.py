"""HTTP ingest client for the OpenTerms receipts service.

Thin wrapper over :mod:`openterms.signing` and :mod:`openterms.verification`.
Builds, signs, and POSTs receipts to a configured ingest URL, and optionally
fetches the workspace JWKS for the local verify path.

Design:

* No third-party HTTP dependency. Uses :mod:`urllib.request` directly so the
  ``openterms`` package keeps its only runtime dependency as ``cryptography``.
* Auth is a placeholder. A bearer-token header is sent if ``api_key`` is set,
  but the ingest service does not yet enforce it (see ``IMPLEMENTATION_STATUS.md``
  → "Authentication" — auth wiring lands in BUILD_BRIEF Step 10).
* JWKS is accepted as an in-memory dict or a URL. Production deployments will
  point at a hosted ``/.well-known/jwks.json``; tests pass a dict directly.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .receipts.canonical import build_payload
from .receipts.signing import PrivateKeyInput, sign_receipt
from .receipts.verification import VerifyResult, verify_receipt

_DEFAULT_TIMEOUT_SECONDS = 10.0


class IngestError(RuntimeError):
    """Raised on transport or HTTP failures from the ingest endpoint."""

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        body: str | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.body = body
        self.code = code


@dataclass(frozen=True)
class IngestResponse:
    """Server response from ``POST /v1/receipts/ingest``."""

    canonical_hash: str
    ingested_at: str
    duplicate: bool
    receipt: dict[str, Any]
    decision: dict[str, Any] | None
    status: int


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class IngestClient:
    """Client for emitting signed receipts to an OpenTerms ingest service.

    Parameters
    ----------
    base_url:
        Root URL of the ingest service, e.g. ``http://localhost:3000``. No
        trailing slash required.
    workspace_id:
        UUID identifying the workspace. The service rejects receipts whose
        ``workspace_id`` does not match its configured value.
    key_id:
        ``kid`` of the signing key. Must match an entry in the workspace JWKS.
    private_key:
        Either a 32-byte Ed25519 seed or an :class:`Ed25519PrivateKey`.
    agent_id:
        Default agent id used by :meth:`emit_receipt` callers that don't pass
        ``agent_id`` explicitly. Optional.
    api_key:
        Placeholder for the bearer token. Sent as ``Authorization: Bearer ...``
        if set, but the current service does not enforce it
        (BUILD_BRIEF Step 10).
    jwks:
        Optional pre-built JWKS dict. When set, :meth:`verify` uses it directly.
    jwks_url:
        Optional URL to fetch the JWKS from. Used by :meth:`fetch_jwks` and as
        a fallback if :meth:`verify` is called without an in-memory JWKS.
    timeout:
        Per-request socket timeout in seconds.
    """

    def __init__(
        self,
        *,
        base_url: str,
        workspace_id: str,
        key_id: str,
        private_key: PrivateKeyInput,
        agent_id: str | None = None,
        api_key: str | None = None,
        jwks: dict | None = None,
        jwks_url: str | None = None,
        timeout: float = _DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        if not base_url:
            raise ValueError("base_url is required")
        self.base_url = base_url.rstrip("/")
        self.workspace_id = workspace_id
        self.key_id = key_id
        self._private_key = private_key
        self.agent_id = agent_id
        self.api_key = api_key
        self._jwks = jwks
        self.jwks_url = jwks_url
        self.timeout = timeout

    # ----- public API -----

    def emit_receipt(
        self,
        *,
        action_type: str,
        terms_url: str,
        terms_hash: str,
        action_context: dict[str, Any] | None = None,
        pricing_version: str = "v1",
        amount_charged: int = 0,
        agent_id: str | None = None,
        receipt_id: str | None = None,
        timestamp: str | None = None,
        created_at: str | None = None,
        idempotency_key: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> IngestResponse:
        """Build, sign, and POST a pre-action receipt.

        ``extra`` is merged into the receipt before signing and may carry any
        of the v0.1/v0.2 optional signed fields (``ors_version``, ``issuer``,
        ``terms_type``, ``terms_service``, ``terms_version``, etc).
        """
        agent = agent_id or self.agent_id
        if not agent:
            raise ValueError("agent_id must be provided either at init or per-call")
        ts = timestamp or _utcnow_iso()
        receipt: dict[str, Any] = {
            "workspace_id": self.workspace_id,
            "agent_id": agent,
            "action_type": action_type,
            "terms_url": terms_url,
            "terms_hash": terms_hash,
            "timestamp": ts,
            "pricing_version": pricing_version,
            "receipt_id": receipt_id or str(uuid.uuid4()),
            "amount_charged": amount_charged,
            "created_at": created_at or ts,
        }
        if action_context is not None:
            receipt["action_context"] = action_context
        if extra:
            for k, v in extra.items():
                if v is not None:
                    receipt[k] = v

        payload = build_payload(receipt)
        signed = sign_receipt(payload, self._private_key, self.key_id)
        return self._post(signed, idempotency_key=idempotency_key)

    def emit_post_action_receipt(
        self,
        *,
        receipt_id: str,
        post_state_hash: str,
        action_type: str,
        terms_url: str,
        terms_hash: str,
        agent_id: str | None = None,
        amount_charged: int = 0,
        pricing_version: str = "v1",
        timestamp: str | None = None,
        created_at: str | None = None,
        idempotency_key: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> IngestResponse:
        """Build, sign, and POST a post-action receipt.

        The ORS v0.1 wire format does not have a separate post-action shape —
        the post-state hash lives in ``action_context.post_state_hash`` and the
        ``receipt_id`` is the same UUID as the originating pre-action receipt.
        """
        ctx: dict[str, Any] = {"post_state_hash": post_state_hash}
        if extra and "action_context" in extra and isinstance(extra["action_context"], dict):
            ctx = {**extra["action_context"], **ctx}
            extra = {k: v for k, v in extra.items() if k != "action_context"}
        return self.emit_receipt(
            action_type=action_type,
            terms_url=terms_url,
            terms_hash=terms_hash,
            action_context=ctx,
            agent_id=agent_id,
            amount_charged=amount_charged,
            pricing_version=pricing_version,
            receipt_id=receipt_id,
            timestamp=timestamp,
            created_at=created_at,
            idempotency_key=idempotency_key,
            extra=extra,
        )

    def fetch_jwks(self, url: str | None = None) -> dict:
        """Fetch and cache a JWKS document from ``url`` or ``self.jwks_url``."""
        target = url or self.jwks_url
        if not target:
            raise ValueError("no jwks_url configured; pass url= or set jwks_url at init")
        req = urllib.request.Request(target, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = resp.read()
        except urllib.error.URLError as err:
            raise IngestError(f"failed to fetch JWKS from {target}: {err}") from err
        jwks = json.loads(body.decode("utf-8"))
        self._jwks = jwks
        return jwks

    def verify(self, receipt: dict, jwks: dict | None = None) -> VerifyResult:
        """Verify a receipt against an in-memory JWKS or the configured URL."""
        keys = jwks if jwks is not None else self._jwks
        if keys is None:
            if self.jwks_url:
                keys = self.fetch_jwks()
            else:
                raise ValueError(
                    "no JWKS available; pass jwks= or configure jwks_url / jwks at init"
                )
        return verify_receipt(receipt, keys)

    # ----- internals -----

    def _post(
        self, signed: dict, *, idempotency_key: str | None
    ) -> IngestResponse:
        url = f"{self.base_url}/v1/receipts/ingest"
        body = json.dumps(signed).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                status = resp.getcode()
                response_body = resp.read()
        except urllib.error.HTTPError as err:
            err_body = err.read().decode("utf-8", errors="replace")
            code: str | None = None
            try:
                code = json.loads(err_body).get("code")
            except (ValueError, AttributeError):
                pass
            raise IngestError(
                f"ingest failed with HTTP {err.code}",
                status=err.code,
                body=err_body,
                code=code,
            ) from err
        except urllib.error.URLError as err:
            raise IngestError(f"ingest transport error: {err}") from err
        parsed = json.loads(response_body.decode("utf-8"))
        return IngestResponse(
            canonical_hash=parsed["hash"],
            ingested_at=parsed["ingested_at"],
            duplicate=bool(parsed.get("duplicate", False)),
            receipt=parsed.get("receipt", {}),
            decision=parsed.get("decision"),
            status=status,
        )
