"""Tests for ORS v0.1 canonicalization.

Two sections:
  1. Spec vectors — the twelve Appendix B vectors from ORS v0.1. The shared
     vector file at ``tests/vectors/ors-v0.1/canonicalization.json`` is the
     source of truth for both this Python implementation and the future
     TypeScript port.
  2. Corner-case tests — four cases the spec leaves ambiguous. Each locks in a
     decision made in ``openterms.canonical`` (matching ``verify.py``).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from openterms.receipts.canonical import CanonicalizationError, canonicalize

REPO_ROOT = Path(__file__).resolve().parents[3]
VECTORS_PATH = REPO_ROOT / "tests" / "vectors" / "ors-v0.1" / "canonicalization.json"

with VECTORS_PATH.open(encoding="utf-8") as _f:
    VECTORS = json.load(_f)


def _hex_window(data: bytes, offset: int, radius: int = 8) -> str:
    start = max(0, offset - radius)
    end = min(len(data), offset + radius + 1)
    return " ".join(f"{b:02x}" for b in data[start:end])


def _format_diff(produced: bytes, expected: bytes) -> str:
    if produced == expected:
        return "(identical)"
    diff_offset = next(
        (i for i in range(min(len(produced), len(expected))) if produced[i] != expected[i]),
        min(len(produced), len(expected)),
    )
    caret_col = (diff_offset - max(0, diff_offset - 8)) * 3
    caret = " " * caret_col + "^^"
    return (
        f"first divergence at byte offset {diff_offset}\n"
        f"expected (len={len(expected)}): {expected!r}\n"
        f"produced (len={len(produced)}): {produced!r}\n"
        f"expected window: {_hex_window(expected, diff_offset)}\n"
        f"produced window: {_hex_window(produced, diff_offset)}\n"
        f"                 {caret}"
    )


@pytest.mark.parametrize("vector", VECTORS, ids=lambda v: v["name"])
def test_vector(vector: dict) -> None:
    produced = canonicalize(vector["input"])
    expected = vector["expected_canonical"].encode("utf-8")
    assert produced == expected, _format_diff(produced, expected)

    produced_sha = hashlib.sha256(produced).hexdigest()
    assert produced_sha == vector["expected_sha256"], (
        f"sha256 mismatch:\n"
        f"  expected: {vector['expected_sha256']}\n"
        f"  produced: {produced_sha}"
    )


def test_corner_nulls_inside_arrays() -> None:
    """Null-stripping applies to objects only; nulls inside arrays survive.

    See ``strip_nulls`` in openterms/canonical.py and verify.py:75-81.
    """
    assert canonicalize({"items": [1, None, 2]}) == b'{"items":[1,null,2]}'


def test_corner_empty_containers_survive_null_stripping() -> None:
    """An object that becomes empty after null-stripping is not pruned.

    ``{"a": null, "b": {}}`` → ``{"b":{}}`` — ``b`` is kept even though its
    value is empty. Locks in the decision flagged as ambiguity #3 in the
    implementation proposal.
    """
    assert canonicalize({"a": None, "b": {}}) == b'{"b":{}}'


def test_corner_unicode_no_normalization() -> None:
    """NFC and NFD inputs produce different canonical bytes.

    ``café`` with U+00E9 vs. ``café`` with combining mark — the
    canonicalizer must not normalize. This is the gotcha flagged as ambiguity
    #1: applications passing user-supplied strings that have not been
    pre-normalized will get different receipt hashes for visually identical
    text. Test asserts the divergence is intentional.
    """
    nfc = canonicalize({"name": "café"})
    nfd = canonicalize({"name": "café"})
    assert nfc != nfd
    assert nfc == '{"name":"café"}'.encode()
    assert nfd == '{"name":"café"}'.encode()


def test_corner_integer_that_arrived_as_float_is_rejected() -> None:
    """Floats are rejected outright (parity with the TS port).

    Previously the canonicalizer passed floats through as ``1000.0``, but
    Python ``repr`` and JavaScript ``Number.prototype.toString`` do not
    agree on every IEEE-754 double, so silent pass-through risks
    cross-language divergence. The strict rejection is defense in depth.
    """
    with pytest.raises(CanonicalizationError):
        canonicalize({"n": 1000.0})


# --- Strict rejection parity (matches apps/api canonical.parity.test.ts) ---


def test_reject_float() -> None:
    with pytest.raises(CanonicalizationError, match="Float"):
        canonicalize({"n": 1.5})


def test_reject_unsafe_integer() -> None:
    # 2**53 — first integer JS Number cannot represent exactly.
    with pytest.raises(CanonicalizationError, match="MAX_SAFE_INTEGER"):
        canonicalize({"n": 9007199254740992})


def test_reject_non_bmp_key() -> None:
    # U+1F600 GRINNING FACE
    with pytest.raises(CanonicalizationError, match="non-BMP"):
        canonicalize({"😀": 1})


def test_accept_bmp_unicode_key() -> None:
    # Sanity: ordinary unicode keys still work.
    assert canonicalize({"café": 1}) == '{"café":1}'.encode()
