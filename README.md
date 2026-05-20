# OpenTerms Agent Action Observability

Verifiable audit trail for autonomous AI agent actions. Every action produces an
[ORS v0.1](https://github.com/jstibal/ors-spec) signed receipt; this repo
contains the ingest pipeline, SDKs, and (eventually) the policy, query, and
simulation surfaces.

See [`LLM_Handoff_Brief.md`](LLM_Handoff_Brief.md) for the full product brief
and [`openapi.yaml`](openapi.yaml) for the public API contract.

## Packages

| Path | What it is | How to test |
| --- | --- | --- |
| [`apps/api/`](apps/api/) | TypeScript/Fastify ingest service. Verifies Ed25519 signatures and persists receipts to Postgres. | `cd apps/api && npm test` |
| [`packages/openterms-py/`](packages/openterms-py/) | Python SDK. Canonicalization, signing, verification, JWKS helpers. | `cd packages/openterms-py && .venv/bin/pytest` |
| [`tests/integration/`](tests/integration/) | Cross-language end-to-end test. Spawns `apps/api/`, signs from Python, verifies in TypeScript, persists to Postgres. | `.venv/bin/pytest tests/integration -v` |
| [`tests/vectors/ors-v0.1/`](tests/vectors/ors-v0.1/) | Shared canonicalization test vectors. Read by both Python and TypeScript test suites. | — |

## Quick test (everything)

```bash
# Python SDK unit + verification tests
cd packages/openterms-py && .venv/bin/pytest -q

# TypeScript unit tests (canonical parity + 6 verify error codes)
cd ../../apps/api && npm install && npm test

# Cross-language integration (requires Postgres running locally)
cd ../.. && packages/openterms-py/.venv/bin/pytest tests/integration -v
```

## Status

Built so far: ORS canonicalization (Python + TypeScript, byte-parity proven by
shared vectors), Ed25519 signing (Python) and verification (Python +
TypeScript), `POST /v1/receipts/ingest` with idempotency and append-only
Postgres storage.

**Not production-ready.** Bearer auth is deliberately deferred. See
[`apps/api/README.md`](apps/api/README.md) for the full deferred list.
