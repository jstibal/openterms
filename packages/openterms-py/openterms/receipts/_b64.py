"""Base64url helpers (RFC 4648 Section 5, no padding)."""

from __future__ import annotations

import base64


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64url_decode(data: str) -> bytes:
    pad_len = (-len(data)) % 4
    return base64.urlsafe_b64decode((data + "=" * pad_len).encode("ascii"))
