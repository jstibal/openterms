# Changelog

All notable changes to `openterms-py` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-05-21

This release merges the permission-lookup library (0.4.x) and the ORS v0.1
receipts library (previously a standalone codebase) into a single package.
The two halves remain independently usable.

### Added
- ORS v0.1 receipts: `sign_receipt`, `verify_receipt`, `IngestClient`,
  canonical hashing, JWKS helpers, policy engine (`evaluate`, `Rule`,
  `Policy`, `Decision`, `EvalContext`).
- Top-level convenience imports so both halves are reachable from
  `import openterms`.
- Nested submodule layout: `openterms.permissions`, `openterms.receipts`,
  `openterms.policy`.

### Changed (BREAKING)
- **License: MIT → Apache-2.0.** New `LICENSE` file; `pyproject.toml` SPDX
  identifier updated; README footer notes the change.
- **Python: >=3.9 → >=3.10.** Type hints modernized to PEP 604 unions
  (`X | None` instead of `Optional[X]`).
- `Receipt` dataclass renamed to `PermissionReceipt`.
- Top-level `receipt(...)` function renamed to `permission_receipt(...)`;
  same rename applies to `OpenTermsClient.receipt` →
  `OpenTermsClient.permission_receipt`.
- Submodule path renames (import paths changed):
  - `openterms.cache` → `openterms.permissions.cache`
  - `openterms.client` → `openterms.permissions.client` *(but `openterms.client` now points at `IngestClient`, see Silent breaking changes)*
  - `openterms.models` → `openterms.permissions.models`

### Removed
- PyNaCl dependency and the `[receipts]` extra. Ed25519 work is now done
  with `cryptography>=42`.
- Unused `[async]` extra (httpx was never wired up in 0.4.x code).
- `CheckResult.signed_receipt` field. The `check(..., receipt=True)`
  parameter is gone. For a signed audit trail of permission checks, call
  `IngestClient.emit_receipt(action_type="permission_check", action_context=...)`.

### Silent breaking changes

Import paths that **survive** but resolve to different code. These are the
dangerous ones — code keeps importing successfully but behaves differently.
Audit any 0.4.x code that touches these symbols.

| Surviving import path | 0.4.x behavior | 1.0.0 behavior |
|---|---|---|
| `from openterms.receipts import sign_receipt` | PyNaCl Ed25519 helper that takes `domain`, `action`, `decision`, `source`, `package_version`, returns a flat receipt dict with hex `signature` / `public_key`. | `cryptography` Ed25519 helper that takes a canonical ORS payload, `private_key`, `key_id`; returns the ORS receipt envelope with `signature_b64u` / JWS-style fields. **Different signature, different output shape.** |
| `from openterms.receipts import verify_receipt` | Took one arg (the receipt dict); returned `bool`; raised `VerificationError` on mismatch. | Takes two args (receipt dict, JWKS dict); returns a `VerifyResult` dataclass; does **not** raise on bad signatures — the caller must inspect `result.ok`. |
| `from openterms.receipts import ReceiptError, VerificationError` | Defined in 0.4.x | **Removed.** Replace with checking `VerifyResult.error`. |
| `from openterms import receipts` | The PyNaCl module above. | The ORS module above. The names match; the semantics do not. |
| `openterms.client` (as a module) | 0.4.x's permission-lookup client lived here. | Now hosts `IngestClient`. The 0.4.x permission client moved to `openterms.permissions.client`. |
| `from openterms.client import OpenTermsClient` | Worked in 0.4.x | **ImportError in 1.0.0.** Use `from openterms import OpenTermsClient` or `from openterms.permissions.client import OpenTermsClient`. |

### Migration

| 0.4.x | 1.0.0 |
|---|---|
| `openterms.check(d, a, receipt=True)` | `openterms.check(d, a)` then `IngestClient.emit_receipt(...)` |
| `openterms.receipt(d, a, decision)` | `openterms.permission_receipt(d, a, decision)` |
| `from openterms import Receipt` | `from openterms import PermissionReceipt` |
| `openterms.receipts.sign_receipt(...)` *(PyNaCl, flat dict)* | `openterms.sign_receipt(payload, sk, kid)` *(ORS envelope)* |
| `openterms.receipts.verify_receipt(receipt)` *(returns bool, raises)* | `openterms.verify_receipt(receipt, jwks)` *(returns `VerifyResult`)* |
| `pip install "openterms-py[receipts]"` | `pip install openterms-py` *(Ed25519 always on via cryptography)* |
| `from openterms.cache import TermsCache` | `from openterms.permissions.cache import TermsCache` *(or `from openterms import TermsCache`)* |
| `from openterms.client import OpenTermsClient` | `from openterms.permissions.client import OpenTermsClient` *(or `from openterms import OpenTermsClient`)* |
| `from openterms.models import CheckResult` | `from openterms.permissions.models import CheckResult` *(or `from openterms import CheckResult`)* |
