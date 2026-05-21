"""Permission-lookup half of openterms-py.

Query machine-readable AI agent permissions from ``openterms.json`` files
before your agent acts on a domain.
"""

from .cache import TermsCache, get_default_cache
from .client import (
    OpenTermsClient,
    check,
    clear_cache,
    configure,
    discover,
    fetch,
    permission_receipt,
)
from .models import (
    ApiSpec,
    CacheEntry,
    CheckResult,
    DiscoveryResult,
    McpServer,
    PermissionReceipt,
)

__all__ = [
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
    "get_default_cache",
    "permission_receipt",
]
