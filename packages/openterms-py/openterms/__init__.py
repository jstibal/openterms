"""openterms — Python SDK for the OpenTerms Protocol.

Combines two halves of the same agent-governance story:

* :mod:`openterms.permissions` — query ``openterms.json`` before acting
  (``fetch``, ``check``, ``discover``, ``permission_receipt``).
* :mod:`openterms.receipts` — sign and verify ORS v0.1 receipts after acting
  (``sign_receipt``, ``verify_receipt``, JWKS helpers, canonical hashing).
* :mod:`openterms.policy`   — evaluate receipts against governance rules.
* :class:`openterms.IngestClient` — HTTP client that builds, signs, POSTs,
  and verifies receipts against the OpenTerms ingest service.
"""

__version__ = "1.0.0"

# --- Permission-lookup half ------------------------------------------------
from .permissions import (
    ApiSpec,
    CacheEntry,
    CheckResult,
    DiscoveryResult,
    McpServer,
    OpenTermsClient,
    PermissionReceipt,
    TermsCache,
    check,
    clear_cache,
    configure,
    discover,
    fetch,
    permission_receipt,
)

# --- Receipts (ORS v0.1) half ---------------------------------------------
from .receipts import (
    DOMAIN_SEPARATOR,
    CanonicalizationError,
    VerifyResult,
    build_jwks,
    build_payload,
    canonical_hash,
    canonicalize,
    generate_keypair,
    public_key_to_jwk,
    sign_receipt,
    signing_input,
    strip_nulls,
    verify_receipt,
)

# --- Policy engine ---------------------------------------------------------
from .policy import (
    Decision,
    EvalContext,
    Policy,
    Rule,
    evaluate,
    evaluate_with_context,
)

# --- Ingest HTTP client ----------------------------------------------------
from .client import IngestClient, IngestError, IngestResponse

__all__ = [
    "__version__",
    # permissions
    "ApiSpec",
    "CacheEntry",
    "CheckResult",
    "DiscoveryResult",
    "McpServer",
    "OpenTermsClient",
    "PermissionReceipt",
    "TermsCache",
    "check",
    "clear_cache",
    "configure",
    "discover",
    "fetch",
    "permission_receipt",
    # receipts
    "DOMAIN_SEPARATOR",
    "CanonicalizationError",
    "VerifyResult",
    "build_jwks",
    "build_payload",
    "canonical_hash",
    "canonicalize",
    "generate_keypair",
    "public_key_to_jwk",
    "sign_receipt",
    "signing_input",
    "strip_nulls",
    "verify_receipt",
    # policy
    "Decision",
    "EvalContext",
    "Policy",
    "Rule",
    "evaluate",
    "evaluate_with_context",
    # client
    "IngestClient",
    "IngestError",
    "IngestResponse",
]
