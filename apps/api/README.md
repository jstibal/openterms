# @openterms/api

TypeScript/Fastify service that accepts signed ORS v0.1 receipts, verifies the
Ed25519 signature against a workspace JWKS, and persists them to an append-only
Postgres log.

> **Not production-ready.** Bearer auth is **deliberately deferred** to a later
> session; the `TODO(auth)` in `src/routes/receipts.ts` marks the hook point.
> Run only against local/test workloads until auth lands.

## Stack

- Node.js 20+, TypeScript, ES modules
- [Fastify](https://fastify.dev) for HTTP
- `@noble/ed25519` + `@noble/hashes` for crypto
- `pg` (node-postgres) with raw parameterized queries
- `vitest` for unit tests

## Layout

```
src/
  server.ts             Fastify bootstrap, migrations, signal handling
  config.ts             Env parsing (DATABASE_URL, JWKS_SOURCE, WORKSPACE_ID)
  core/
    canonical.ts        ORS canonicalization — byte-parity with canonical.py
    verify.ts           Ed25519 verification — six error codes
  routes/
    receipts.ts         POST /v1/receipts/ingest
  db/
    client.ts           pg Pool singleton
    receipts.ts         insertReceipt, findByCanonicalHash, idempotency lookup
    migrate.ts          Runs every .sql file in migrations/ in lexical order
    migrations/         001_create_receipts.sql, 002_create_idempotency_keys.sql
  jwks/
    source.ts           file:<path> | memory:<json> loader
  lib/
    errors.ts           Verify-error → API-error mapping (six → three codes)
tests/
  canonical.parity.test.ts   Reads tests/vectors/ors-v0.1/canonicalization.json
  verify.test.ts             All six VerifyError codes
```

## Running locally

```bash
# 1. Postgres must be reachable.
createdb openterms_dev

# 2. Generate a dev keypair and JWKS file (use openterms-py).
python -c "
import json, base64
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
sk = Ed25519PrivateKey.generate()
pk = sk.public_key().public_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PublicFormat.Raw,
)
print(json.dumps({'keys': [{
    'kty': 'OKP', 'crv': 'Ed25519', 'kid': 'dev-key-1',
    'x': base64.urlsafe_b64encode(pk).decode().rstrip('='),
}]}))
" > jwks.local.json

# 3. Configure and run.
cp .env.example .env       # edit DATABASE_URL if needed
npm install
npm run build
npm start
```

The server auto-runs migrations on boot.

## Tests

### TypeScript unit tests

```bash
cd apps/api
npm test
```

Runs the canonicalization parity suite (12 spec vectors + 4 corner cases
mirroring `test_canonical.py`) and the six-error-code verification suite. No
database required.

### Python SDK tests

```bash
cd packages/openterms-py
.venv/bin/pytest
```

Runs the SDK's own canonicalization, signing, and verification tests.

### Cross-language integration test

End-to-end: openterms-py signs a receipt, the test posts it to a spawned
TypeScript service, the service verifies and persists it, the test queries
Postgres directly to confirm the row landed.

Requires `createdb`/`dropdb` on PATH and `node` resolvable in the working
directory. The fixture builds `dist/` on demand if absent.

```bash
cd packages/openterms-py
.venv/bin/pytest /Users/johnstibal/Downloads/openterms-trace/tests/integration -v
# or from the repo root:
# /path/to/.venv/bin/pytest tests/integration -v
```

Six scenarios pass: happy path, duplicate canonical_hash, tampered signature,
unknown issuer, Idempotency-Key conflict, Idempotency-Key replay with same
payload.

## Linting

```bash
npm run lint            # eslint + prettier --check
npm run lint:fix        # auto-fix
npm run typecheck       # tsc --noEmit
```

## Cross-language parity notes

The canonicalization implementation is exercised against the **same** JSON
vector file as the Python SDK: `tests/vectors/ors-v0.1/canonicalization.json`
at the repo root. Both implementations agree byte-for-byte on every vector.

Known divergences from `canonical.py`, documented inline:

1. **Key sort.** JS sorts by UTF-16 code units; Python by Unicode code points.
   They agree on the Basic Multilingual Plane. Supplementary-plane keys are
   not supported and should be rejected at the SDK input layer.
2. **Float emission.** Python distinguishes `1000.0` (float) from `1000`
   (int); JS does not. The ORS spec says floats SHOULD NOT appear in receipt
   payloads; SDK input validation is the right enforcement point.

## Deferred to later sessions

- **Bearer auth.** `TODO(auth)` in `routes/receipts.ts`. The API key check
  belongs at the top of the route handler, before validation.
- **JWKS over HTTP.** Only `file:` and `memory:` schemes are wired today.
- **Other endpoints.** Only `POST /v1/receipts/ingest` and `GET /healthz`
  exist. The full surface in `openapi.yaml` is built in subsequent steps.
- **Drizzle ORM.** BUILD_BRIEF mandates Drizzle to match the (absent) legacy
  codebase. Deferred until there's a real second table or query to motivate
  it; raw `pg` is correct for one append-only insert.
