# Implementation Status

This document tracks what is built, what is planned, and what is intentionally
deferred. It exists so a reader of [README.md](README.md) or
[openapi.yaml](openapi.yaml) can immediately distinguish shipped behavior from
contract surface.

The build plan is [`LLM_Handoff_Brief.md`](LLM_Handoff_Brief.md) Section 8
(a ten-step sequence). The current state is **end of Step 8** (simulate
endpoint shipped). Steps 9 (SDK packaging / framework adapters) and 10
(deployment, JWKS hosting, auth, rate limiting, key management) are not done.

## HTTP endpoints

| Endpoint | Status | Notes |
| --- | --- | --- |
| `POST /v1/receipts/ingest` | Implemented | Verifies Ed25519, persists to Postgres, idempotency by `Idempotency-Key` or canonical hash. |
| `GET /v1/receipts` | Implemented | Cursor pagination, filters by `agent_id`, `action_type`, `decision`, `tool_id`, time window. |
| `GET /v1/receipts/{canonical_hash}` | Implemented | Returns the stored receipt by canonical hash. |
| `GET /v1/decisions` | Implemented | Query decisions joined to receipts. |
| `POST /v1/simulate` | Implemented | Step 8: evaluates a policy against a fixture corpus. |
| `GET /.well-known/jwks.json` | **Planned — Step 10** | Public JWKS distribution. Current JWKS loader supports `file:` and `memory:` schemes for development only. |
| `POST /v1/policies` / `GET /v1/policies/...` | **Planned** | Policy CRUD. Active policy is currently hardcoded — see "Policy management" below. |
| Auth-related endpoints (key creation / rotation) | **Planned — Step 10** | See "Key management" below. |

## Security and deployment readiness

The service is suitable for local development and integration testing only.
The following are **not** in place and are blockers for any non-local
deployment:

- **Authentication.** No bearer-token check on any endpoint. `TODO(auth)`
  markers exist at the intended hook points in `apps/api/src/routes/*.ts`.
- **Rate limiting.** No per-workspace or per-IP limits. Planned for Step 10.
- **Secret management.** Private signing keys are loaded from local files /
  env strings for development. Production key custody (HSM, KMS, or
  encrypted-at-rest with rotation) is not implemented.
- **JWKS public endpoint.** `GET /.well-known/jwks.json` is not implemented;
  verification currently reads JWKS from `file:` or `memory:` schemes.
- **Monitoring / metrics / structured request logging.** Application logs
  exist but no metrics export, no health endpoint beyond Fastify's default,
  no error-rate alerting hooks.
- **Single-workspace service instance.** The service is hardcoded to a
  single `WORKSPACE_ID` env var. Multi-tenant routing is not implemented.
- **CI gates.** Coverage gates and a Postgres-backed integration job are
  partial (see "CI" below).

## Policy management

- The active policy is **hardcoded** in the service for the current build
  (intentional — policy CRUD is a separate workstream). Policy JSON ships
  with the repo; runtime policy updates require redeploy.
- `daily_limit` rules are evaluated, but the aggregate snapshot they consume
  is computed inline in the ingest path against prior receipts; see
  `apps/api/src/routes/receipts.ts`.
- `ENGINE_ERROR` from the policy engine is converted to a stored deny
  (reason `ENGINE_ERROR`) so the ingest path stays resilient. See
  [`apps/api/src/core/policy.ts`](apps/api/src/core/policy.ts) for the
  rationale; the receipt is still persisted, with the engine failure
  recorded as the decision reason rather than dropped.

## Monorepo structure

The full structure in `LLM_Handoff_Brief.md` Section 7 includes
`packages/openterms-ts/`, `packages/langchain-openterms/`,
`packages/crewai-openterms/`, and deployment scripts. These are built in
Steps 9 and 10 and **are not present yet**. The current layout is:

```
apps/api/                 # Fastify ingest + query + simulate service
packages/openterms-py/    # Python SDK (canonicalization, signing, verify)
tests/integration/        # Cross-language end-to-end test
tests/vectors/ors-v0.1/   # Shared canonicalization vectors
```

The absence of the additional packages is intentional staged deviation from
the brief, not drift.

## CI

- Unit tests (TS + Python) run via `npm test` and `pytest` respectively.
- Integration tests (`apps/api/tests/ingest.integration.test.ts`,
  `query.test.ts`) require `TEST_DATABASE_URL` and skip silently otherwise.
- A GitHub Actions workflow with a Postgres service container is **planned**
  so the integration tests run on every push without manual configuration.

## Audit / observability gaps

- Failed receipt verifications are written to a `verification_errors`
  table (see migration `004_create_verification_errors.sql`) so they are
  queryable after the fact rather than only appearing in application logs.
- `raw_receipt` is stored as `JSONB`. This preserves the semantic JSON
  (key/value structure) but **not the original byte sequence** — JSONB
  normalizes key order and whitespace. The canonical hash is the source
  of truth for tamper detection; byte-exact preservation of the request
  body is not a current requirement.

## Calibration of public claims

The README and openapi.yaml describe the **target** system. They do not
imply that auth, rate limiting, key management, multi-tenancy, JWKS hosting,
or policy CRUD are in place today. Treat this document as the source of
truth for what is shipped.
