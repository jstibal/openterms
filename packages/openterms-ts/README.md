# @openterms-ai/sdk

OpenTerms TypeScript SDK — ORS v0.1 canonicalization, Ed25519 signing, verification, policy evaluation, and an HTTP client for the OpenTerms ingest service.

Behavioral parity with [`openterms` on PyPI](https://pypi.org/project/openterms/) is enforced by the shared canonicalization vectors in [`tests/vectors/ors-v0.1/canonicalization.json`](https://github.com/jstibal/openterms/blob/main/tests/vectors/ors-v0.1/canonicalization.json).

## Install

```bash
npm install @openterms-ai/sdk
```

Runtime dependencies: `@noble/ed25519`, `@noble/hashes`. No HTTP client dependency — the SDK uses the global `fetch` (Node 18+).

## Quickstart

```typescript
import { IngestClient } from '@openterms-ai/sdk';
import { randomBytes } from 'node:crypto';

const privateKey = randomBytes(32); // 32-byte Ed25519 seed

const client = new IngestClient({
  baseUrl: 'http://localhost:3000',
  workspaceId: '00000000-0000-4000-8000-0000000000aa',
  keyId: 'my-key',
  privateKey,
  agentId: 'my-agent',
});

const response = await client.emitReceipt({
  actionType: 'tool_call',
  termsUrl: 'https://example.com/terms',
  termsHash: 'a'.repeat(64),
  actionContext: { tool_id: 'search', args: { q: 'hello' } },
});
console.log(response.canonicalHash, response.duplicate);
```

Post-action receipt:

```typescript
await client.emitPostActionReceipt({
  receiptId: response.receipt.receipt_id as string,
  postStateHash: '<sha256 of the tool output>',
  actionType: 'tool_call',
  termsUrl: 'https://example.com/terms',
  termsHash: 'a'.repeat(64),
});
```

Offline verification:

```typescript
import { verifyReceipt } from '@openterms-ai/sdk';
const result = verifyReceipt(receipt, jwks);
console.assert(result.valid);
```

## What this SDK does

- Produces and verifies ORS v0.1 / v0.2 receipts. Canonicalization is byte-identical with the Python SDK (vectors checked in CI).
- Signs with Ed25519 (`@noble/ed25519`). Signing input is `"ORSv0.1\\x00" + sha256(canonical bytes)`.
- POSTs signed receipts to an OpenTerms ingest service via `fetch`.
- Verifies receipts offline against an in-memory JWKS object or a fetched JWKS URL.
- Evaluates the OpenTerms policy engine deterministically against a receipt (parity with the Python engine).

## What this SDK does NOT do

- **It does not run an ingest service.** `IngestClient.emitReceipt` POSTs to a URL you control; you must run the OpenTerms API service (or point at a hosted one) for emissions to land. See [`apps/api`](https://github.com/jstibal/openterms/tree/main/apps/api).
- **It does not handle auth.** The `apiKey` option is a placeholder that sends `Authorization: Bearer <token>`, but the ingest service does not yet enforce bearer tokens. Auth lands in BUILD_BRIEF Step 10 (see [IMPLEMENTATION_STATUS.md](https://github.com/jstibal/openterms/blob/main/IMPLEMENTATION_STATUS.md)).
- **It does not host a JWKS.** Verification requires you to supply the JWKS — either inline or via `jwksUrl`. A hosted `/.well-known/jwks.json` for the OpenTerms service is planned for BUILD_BRIEF Step 10.
- **It does not manage keys.** Key generation, rotation, and storage are your responsibility.
- **It does not retry on transient ingest errors.** `IngestError` is thrown once; retry logic, backoff, and queueing are out of scope.

## Repository

Source and issue tracker: [`jstibal/openterms`](https://github.com/jstibal/openterms).

## License

Apache-2.0.
