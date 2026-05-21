# Implementation Status

This document tracks what is built, what is planned, and what is intentionally
deferred. It exists so a reader of [README.md](README.md) or
[openapi.yaml](openapi.yaml) can immediately distinguish shipped behavior from
contract surface.

The build plan is [`LLM_Handoff_Brief.md`](LLM_Handoff_Brief.md) Section 8
(a ten-step sequence). **All ten steps have shipped in code.** Step 10
(deployment, hosted JWKS, bearer auth, rate limiting, key management) is
implemented; the only remaining work is the operator action of
provisioning the Render service and turning it on. See
[DEPLOYMENT.md](DEPLOYMENT.md) for the runbook.

Step 10 deliverables in this repo:

- [`render.yaml`](render.yaml) and [`Dockerfile`](Dockerfile) — Render
  service definition and container image.
- [`apps/api/src/auth/bearer.ts`](apps/api/src/auth/bearer.ts) — bearer
  token middleware (`ot_live_` / `ot_test_` prefixes, HMAC lookup against
  `api_keys`, per-request `workspaceId` derivation, opt-out wrapper for
  public routes). Production forces the dev fallback off.
- [`apps/api/src/server.ts`](apps/api/src/server.ts) — `@fastify/rate-limit`
  wired with separate buckets for authenticated ingest, authenticated
  query, and per-IP on public endpoints.
- [`apps/api/src/routes/jwks.ts`](apps/api/src/routes/jwks.ts) — public
  `GET /.well-known/jwks.json` with 24h `max-age` + stale-while-revalidate.
- [`apps/api/src/db/migrations/005_create_workspaces_and_api_keys.sql`](apps/api/src/db/migrations/005_create_workspaces_and_api_keys.sql)
  — `workspaces` and `api_keys` tables.
- Seed script and [`scripts/smoke-staging.sh`](scripts/smoke-staging.sh)
  for post-deploy verification.
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — production runbook (provisioning,
  env vars, secrets, smoke verification, rotation).

Step 8 deliverables (SDKs and adapters) remain as previously shipped:

- [`packages/openterms-py`](packages/openterms-py/) — `openterms` on PyPI
  (prepared, not published). `IngestClient.emit_receipt` /
  `emit_post_action_receipt` ship and the v0.2 optional signed fields
  (`terms_type`, `terms_service`, `terms_version`) are accepted under the
  signature.
- [`packages/openterms-ts`](packages/openterms-ts/) — `@openterms/sdk` on
  npm (prepared). Extracted from `apps/api/src/core/`; the API service
  now imports canonicalization, signing, verification, and policy from
  this package.
- [`packages/langchain-openterms`](packages/langchain-openterms/) —
  `openterms-langchain` on PyPI (prepared). LangChain
  `BaseCallbackHandler` that signs and posts a receipt on every
  `on_tool_start` (and optionally `on_tool_end`).
- [`packages/crewai-openterms`](packages/crewai-openterms/) —
  `openterms-crewai` on PyPI (prepared). Callable-level wrapper; CrewAI
  is intentionally not a hard runtime dependency.

The integration test `tests/integration/test_adapter_e2e.py` exercises
the full chain (LangChain adapter → IngestClient → Fastify ingest →
Postgres → query → offline Python re-verify).

## HTTP endpoints

| Endpoint | Status | Notes |
| --- | --- | --- |
| `GET /healthz` | Implemented (public) | Liveness probe, no auth, no rate limit beyond per-IP. |
| `POST /v1/receipts/ingest` | Implemented (authenticated) | Verifies Ed25519, persists to Postgres, idempotency by `Idempotency-Key` or canonical hash. |
| `GET /v1/receipts` | Implemented (authenticated) | Cursor pagination, filters by `agent_id`, `action_type`, `decision`, `tool_id`, time window. |
| `GET /v1/receipts/{canonical_hash}` | Implemented (authenticated) | Returns the stored receipt by canonical hash. |
| `GET /v1/decisions` | Implemented (authenticated) | Query decisions joined to receipts. |
| `POST /v1/simulate` | Implemented (authenticated) | Evaluates a policy against a fixture corpus. |
| `GET /v1/simulate/{job_id}` | Implemented (authenticated) | Async-result stub: no job store yet, so any `job_id` returns 404. Surface contract reserved for the async simulation flow. |
| `GET /.well-known/jwks.json` | Implemented (public) | 24h `max-age` + stale-while-revalidate. JWKS source still selected by env (`file:` or `memory:`); rotation propagates on next request. |
| `POST /v1/policies` / `GET /v1/policies/...` | **Planned** | Policy CRUD. Active policy is currently hardcoded — see "Policy management" below. Returns 404. |
| Auth key creation / rotation endpoints | **Planned** | API keys are provisioned via the seed script / DB today. Returns 404. |
| All other paths described in `openapi.yaml` | **Planned** | Contract surface only; returns 404. |

## Product capability status

| Capability | Status |
| --- | --- |
| Bearer authentication | Implemented (`Authorization: Bearer ot_live_…` / `ot_test_…`, HMAC lookup, per-route opt-out for public endpoints). |
| Rate limiting | Implemented (`@fastify/rate-limit`, separate buckets for authenticated ingest, authenticated query, and per-IP public). |
| JWKS hosting endpoint | Implemented (`GET /.well-known/jwks.json`, edge-cacheable). |
| Multi-workspace per service instance | **Not implemented.** API keys carry `workspace_id`, but a single service instance still serves a single configured workspace. Multi-tenant routing is a separate workstream. |
| Production deployment | Infrastructure ready (`render.yaml`, `Dockerfile`, `DEPLOYMENT.md`); operator must provision the Render service, configure env vars, and run the migration / seed. Not yet provisioned. |
| Dashboard / OAuth | **Deferred** to a separate workstream. |

## Security and deployment readiness

- **Authentication.** Bearer-token check is wired on every non-public
  endpoint. `NODE_ENV=production` forces the dev workspace fallback off
  so missing/invalid tokens always return 401.
- **Rate limiting.** Separate buckets for authenticated ingest, authenticated
  query, and per-IP on public endpoints. Limits configurable via env.
- **JWKS public endpoint.** Implemented at `/.well-known/jwks.json` with
  long edge caching. The underlying JWKS source is still selected by env
  (`file:` or `memory:`); production key custody (HSM / KMS / encrypted-
  at-rest with rotation) remains a separate workstream.
- **Secret management.** Documented in [`DEPLOYMENT.md`](DEPLOYMENT.md):
  `API_KEY_SALT`, `JWKS_SOURCE`, signing key material, and `DATABASE_URL`
  are injected via Render env vars; the seed script provisions the first
  workspace and API key. Long-term key custody (HSM/KMS) is still a
  future workstream.
- **Monitoring / metrics / structured request logging.** Application logs
  exist. `GET /healthz` is the liveness probe. Metrics export and error-rate
  alerting are not yet wired.
- **Production deployment.** Render service is not yet provisioned. Once
  the operator follows the runbook, `scripts/smoke-staging.sh` exercises
  the live endpoint to confirm health, auth, and ingest round-trip.
- **CI gates.** Green on both jobs as of commit `02288e8` — the Python
  unit/parity job and the API job (typecheck + unit + Postgres-backed
  integration tests).

## Policy management

- The active policy is **hardcoded** in the service for the current build
  (intentional — policy CRUD is a separate workstream). Policy JSON ships
  with the repo; runtime policy updates require redeploy.
- `daily_limit` rules are evaluated, and the aggregate snapshot they consume
  is computed inline in the ingest path against prior receipts; see
  `apps/api/src/routes/receipts.ts` (red-team item 16 — shipped).
- `ENGINE_ERROR` from the policy engine is converted to a stored deny
  (reason `ENGINE_ERROR`) so the ingest path stays resilient. See
  [`apps/api/src/core/policy.ts`](apps/api/src/core/policy.ts) for the
  rationale; the receipt is still persisted, with the engine failure
  recorded as the decision reason rather than dropped.

## Monorepo structure

```
apps/api/                       # Fastify ingest + query + simulate + JWKS service
packages/openterms-py/          # Python SDK (canonicalization, signing, verify, client)
packages/openterms-ts/          # TypeScript SDK (@openterms/sdk)
packages/langchain-openterms/   # LangChain adapter (openterms-langchain)
packages/crewai-openterms/      # CrewAI adapter (openterms-crewai)
tests/integration/              # Cross-language and adapter end-to-end tests
tests/vectors/ors-v0.1/         # Shared canonicalization vectors
tests/fixtures/corpus/          # 500-receipt simulation corpus
render.yaml, Dockerfile         # Deployment infrastructure
scripts/smoke-staging.sh        # Post-deploy smoke check
DEPLOYMENT.md                   # Production runbook
```

The monorepo is wired with npm workspaces at the root for the TypeScript
packages; the Python packages are independent distributions that each
depend on `openterms>=0.1.0` for canonicalization and signing.

## CI

- Python job: `pytest` against `packages/openterms-py/` — **162 passing,
  2 skipped** as of the current main.
- API job: `npm test --workspace @openterms/api` against a Postgres 16
  service container. Locally without Postgres, **74 tests pass and 43
  DB-dependent tests skip**; in CI all 43 DB-dependent tests run.
- Both jobs green on commit `02288e8` (workflow run 26225191846).
- The workflow is defined in [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
  and runs on every push to `main` and every pull request.

## Audit / observability gaps

- Failed receipt verifications are written to a `verification_errors`
  table (see migration `004_create_verification_errors.sql`) so they are
  queryable after the fact rather than only appearing in application logs
  (red-team item 9 — shipped).
- `raw_receipt` is stored as `JSONB`. This preserves the semantic JSON
  (key/value structure) but **not the original byte sequence** — JSONB
  normalizes key order and whitespace. The canonical hash is the source
  of truth for tamper detection; byte-exact preservation of the request
  body is not a current requirement.

## Known gaps and trade-offs

- **Fixture corpus.** `tests/fixtures/corpus/` ships a deterministic
  500-receipt corpus (seed `5318008`, two policy versions). This is well
  past the originally-flagged target of 50 — surface this if any future
  red-team note still references the 14→50 framing.
- **Webhook payloads.** Outbound webhooks on receipt ingest / decision
  events are not implemented.
- **Regulatory and SLA commitments.** Pending product/legal input — not
  reflected in the README or openapi.yaml.
- **Async simulation results.** `GET /v1/simulate/{job_id}` is a stub
  (no job store), so the async surface is reserved but not functional.
- **Multi-tenant routing.** One service instance still serves one
  workspace, even though `api_keys` carry `workspace_id`.

## Calibration of public claims

The README and openapi.yaml describe the **target** system. The current
shipped surface is the table above. Policy CRUD, multi-tenant routing,
webhook delivery, async simulation results, and the dashboard / OAuth
workstream are not in place today. Treat this document as the source of
truth for what is shipped.

## How to read this document

All ten BUILD_BRIEF Section 8 steps are shipped in code, including
Step 10's auth, rate limiting, hosted JWKS, deployment manifests, and
runbook. The remaining gap to a live service is the operator action of
provisioning the Render service per [DEPLOYMENT.md](DEPLOYMENT.md).
Beyond that, the open product workstreams are policy CRUD,
multi-tenancy, dashboards / OAuth, webhooks, and the async simulation
flow — each tracked in the tables above.
