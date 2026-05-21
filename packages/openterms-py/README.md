# openterms-py

Python SDK for the [OpenTerms Protocol](https://openterms.com).

Two halves of the same agent-governance story, in one library:

- **Permissions** — *before* an agent acts, query `openterms.json` to see what
  the site owner permits.
- **Receipts** — *after* an agent acts, sign and emit an ORS v0.1 receipt so
  the action is auditable and verifiable later.

```bash
pip install openterms-py
```

Runtime dependencies: `cryptography>=42`, `requests>=2.28`. Python `>=3.10`.

---

## Quickstart

### Before you act: check permissions

```python
import openterms

result = openterms.check("example.com", "scrape_data")
if result:
    print("allowed")
else:
    print(f"blocked: {result.decision}")
```

### After you act: emit a signed receipt

```python
from openterms import IngestClient, generate_keypair

sk, pk = generate_keypair()
private_seed = sk.private_bytes_raw()

client = IngestClient(
    base_url="http://localhost:3000",
    workspace_id="00000000-0000-4000-8000-0000000000aa",
    key_id="my-key",
    private_key=private_seed,
    agent_id="my-agent",
)

response = client.emit_receipt(
    action_type="tool_call",
    action_context={"tool_id": "web.fetch", "url": "https://example.com"},
)
print(response.receipt_id, response.canonical_hash)
```

### End-to-end loop: check, act, sign

```python
import openterms
from openterms import IngestClient

result = openterms.check("example.com", "scrape_data")
if not result:
    raise SystemExit(f"blocked: {result.decision}")

# ... agent does the work ...

client = IngestClient(...)
client.emit_receipt(
    action_type="scrape_data",
    action_context={
        "domain": "example.com",
        "openterms_hash": result.raw_value and "...",
    },
)
```

---

## Permissions API

Top-level convenience functions:

| Function | Purpose |
|---|---|
| `openterms.fetch(domain)` | Fetch and parse the domain's `openterms.json` |
| `openterms.check(domain, action)` | Decide allow/deny/not_specified |
| `openterms.discover(domain)` | Read the `discovery` block (MCP servers, API specs) |
| `openterms.permission_receipt(domain, action, decision)` | Local audit artifact (unsigned) |
| `openterms.configure(...)` | Tune TTL, timeout, user agent, registry URL |
| `openterms.clear_cache(domain=None)` | Evict cached entries |

Lookup order: `https://{domain}/.well-known/openterms.json`, then
`https://{domain}/openterms.json`, then the configured registry URL.

Lower-level: `openterms.OpenTermsClient`, `openterms.TermsCache`,
`openterms.CheckResult`, `openterms.DiscoveryResult`, `openterms.PermissionReceipt`.

## Receipts API (ORS v0.1)

Top-level:

| Symbol | Purpose |
|---|---|
| `sign_receipt(payload, private_key, key_id)` | Ed25519-sign a canonical ORS payload |
| `verify_receipt(receipt, jwks)` | Verify; returns a `VerifyResult` (no raise) |
| `canonicalize(payload)` / `canonical_hash(payload)` | RFC 8785-ish JSON canonicalization |
| `build_payload(receipt)` | Strip signature/key fields, return signable payload |
| `generate_keypair()` | Ed25519 keypair |
| `public_key_to_jwk(pk, kid)` / `build_jwks(keys)` | JWKS helpers |
| `IngestClient` | Build, sign, POST receipts to an ingest service |

## Policy engine

```python
from openterms import evaluate, Policy, Rule

policy = Policy(rules=[Rule(rule_id="r1", type="max_amount", params={"amount_cents": 5000})])
decision = evaluate(policy, receipt={...})
```

## Framework adapters

| Package | Install |
|---|---|
| LangChain callback | `pip install langchain-openterms` |
| CrewAI tool wrapper | `pip install crewai-openterms` |

Both depend on `openterms-py>=1.0.0` and surface the same `IngestClient`.

---

## Migrating from 0.4.x

See [CHANGELOG.md](./CHANGELOG.md) for the full migration table. The short
version:

- `Receipt` → `PermissionReceipt`
- `openterms.receipt(...)` → `openterms.permission_receipt(...)`
- `openterms.check(..., receipt=True)` removed — use `IngestClient.emit_receipt`
- `openterms.receipts.sign_receipt` / `verify_receipt` now use `cryptography`
  (not PyNaCl) and have different signatures
- License changed: MIT → Apache-2.0

---

## License

Apache-2.0 — see [LICENSE](./LICENSE).
