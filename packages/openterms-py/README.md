# openterms

OpenTerms Python SDK — ORS v0.1 canonicalization, Ed25519 signing, verification, policy evaluation, and an HTTP client for the OpenTerms ingest service.

## Install

```bash
pip install openterms
```

Runtime dependency: `cryptography>=42`. No HTTP client dependency — the SDK uses `urllib.request` from the standard library.

## Quickstart

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
    terms_url="https://example.com/terms",
    terms_hash="a" * 64,
    action_context={"tool_id": "search", "args": {"q": "hello"}},
)
print(response.canonical_hash, response.duplicate)
```

For post-action receipts (after the tool has run and produced output):

```python
client.emit_post_action_receipt(
    receipt_id=response.receipt["receipt_id"],
    post_state_hash="<sha256 of the tool output>",
    action_type="tool_call",
    terms_url="https://example.com/terms",
    terms_hash="a" * 64,
)
```

To verify a receipt offline:

```python
from openterms import verify_receipt

result = verify_receipt(receipt, jwks_dict)
assert result.valid
```

The client can also fetch a JWKS from a URL:

```python
client = IngestClient(..., jwks_url="https://example.com/.well-known/jwks.json")
jwks = client.fetch_jwks()
assert client.verify(receipt).valid
```

## ORS v0.2 fields

The optional v0.2 signed fields (`terms_type`, `terms_service`, `terms_version`) pass through unchanged. Add them via the `extra` argument to `emit_receipt`:

```python
client.emit_receipt(
    ...,
    extra={
        "terms_type": "saas",
        "terms_service": "example",
        "terms_version": "2025-05-01",
    },
)
```

Canonicalization, signing, and verification all include these fields under the signature, so a receipt produced this way verifies as v0.1 by readers that ignore them and as v0.2 by readers that consume them.

## What this SDK does

- Produces and verifies ORS v0.1 / v0.2 receipts (canonicalization is byte-identical with the [TypeScript SDK](https://www.npmjs.com/package/@openterms/sdk) and the reference [`jstibal/ors-spec` Python verifier](https://github.com/jstibal/ors-spec)).
- Signs with Ed25519. The signing input is `b"ORSv0.1\x00" + sha256(canonical_bytes)`.
- POSTs signed receipts to an OpenTerms ingest service over HTTP.
- Verifies receipts offline against an in-memory JWKS dict or a fetched JWKS URL.
- Evaluates the OpenTerms policy engine deterministically against a receipt (parity with the TypeScript engine).

## What this SDK does NOT do

- **It does not run an ingest service.** `IngestClient.emit_receipt` POSTs to a URL you control; you must run the OpenTerms API service (or point at a hosted one) for emissions to land. See [`apps/api`](https://github.com/jstibal/openterms-trace/tree/main/apps/api).
- **It does not handle auth.** The `api_key` parameter is a placeholder that sends `Authorization: Bearer <token>`, but the ingest service does not yet enforce bearer tokens. Auth wiring lands in BUILD_BRIEF Step 10 (see [IMPLEMENTATION_STATUS.md](https://github.com/jstibal/openterms-trace/blob/main/IMPLEMENTATION_STATUS.md)).
- **It does not host a JWKS.** Verification requires you to supply the JWKS — either as an in-memory `dict` or as a URL the client can fetch from. A hosted `/.well-known/jwks.json` for the OpenTerms service is planned for BUILD_BRIEF Step 10.
- **It does not manage keys.** Generating, rotating, and storing keys is your responsibility. `generate_keypair()` exists for tests and prototyping only.
- **It does not retry on transient ingest errors.** `IngestError` is raised once; retry logic, backoff, and queueing are out of scope.

## Repository

Source and issue tracker: [`jstibal/openterms-trace`](https://github.com/jstibal/openterms-trace).
Marketing site: <https://openterms.org> (planned).

## License

Apache-2.0.
