# Implementation Status

This document tracks what is built, what is planned, and what is intentionally
deferred for the **SDKs in this monorepo**. The backend service (HTTP endpoints,
deployment, runbook, openapi.yaml contract) lives in the private **openterms-api**
repository; the implementation-status content for the server has moved there.

The build plan is [`LLM_Handoff_Brief.md`](LLM_Handoff_Brief.md) Section 8
(a ten-step sequence). **All ten steps have shipped in code and Step 10
is live in staging** at `https://openterms-trace-api.onrender.com` — see
the openterms-api repo's `DEPLOYMENT.md` for the runbook, smoke results,
and Step 10 deliverables (render.yaml, Dockerfile, bearer auth, rate
limiting, JWKS endpoint, workspaces/api_keys migrations).

SDK / adapter deliverables shipped in this monorepo:

- [`packages/openterms-py`](packages/openterms-py/) — `openterms-py` **1.0.0**
  on PyPI. **As of 2026-05-21 this package combines the
  permission-lookup library (previously released as 0.4.0) with the ORS
  v0.1 receipts library.** Layout: `openterms.permissions` (fetch / check /
  discover / `permission_receipt`), `openterms.receipts` (`sign_receipt`,
  `verify_receipt`, canonicalization, JWKS), `openterms.policy` (rule
  evaluation), top-level `openterms.IngestClient`. Test suite: 200 passing
  (38 permissions, 162 receipts/policy/canonical) + 2 skipped. License:
  Apache-2.0. See `packages/openterms-py/CHANGELOG.md` for the 1.0.0
  migration table including a Silent breaking changes section.
- [`packages/openterms-ts`](packages/openterms-ts/) — `@openterms-ai/sdk` **1.0.1**
  on npm. Provides canonicalization, signing, verification, and the
  deterministic policy engine; consumed by the openterms-api backend as
  a regular published npm dependency.
- [`packages/langchain-openterms`](packages/langchain-openterms/) —
  `langchain-openterms` **1.0.0** on PyPI (importable as
  `openterms_langchain`). LangChain `BaseCallbackHandler` that signs and
  posts a receipt on every `on_tool_start` (and optionally `on_tool_end`).
  Independently published by OpenTerms; not an official LangChain project
  package and not endorsed by the LangChain project.
- [`packages/crewai-openterms`](packages/crewai-openterms/) —
  `crewai-openterms` **1.0.0** on PyPI (importable as
  `openterms_crewai`). Callable-level wrapper; CrewAI is intentionally
  not a hard runtime dependency. Independently published by OpenTerms; not
  an official CrewAI project package and not endorsed by the CrewAI
  project.

The cross-language integration tests (LangChain adapter → IngestClient
→ Fastify ingest → Postgres → query → offline Python re-verify) live in
the openterms-api repository alongside the server they exercise. They
consume the published `openterms-py` and `langchain-openterms` packages
from PyPI.

## Backend surface (HTTP endpoints, capabilities, security/deployment, policy)

These sections — HTTP endpoint table, product capability status, security
and deployment readiness, policy management — describe the backend
service and have moved to the openterms-api repository's
`IMPLEMENTATION_STATUS.md`. They are no longer tracked here.

## Repository structure

This is the public **openterms** monorepo — SDKs and shared spec assets
only. The backend service (Fastify + Postgres, Dockerfile, render.yaml,
deployment runbook, cross-language integration tests, openapi.yaml) lives
in the private **openterms-api** repository and consumes `@openterms-ai/sdk`
as a regular published npm dependency.

```
packages/openterms-py/          # Python SDK (canonicalization, signing, verify, client)
packages/openterms-ts/          # TypeScript SDK (@openterms-ai/sdk)
packages/langchain-openterms/   # LangChain adapter (langchain-openterms)
packages/crewai-openterms/      # CrewAI adapter (crewai-openterms)
tests/vectors/ors-v0.1/         # Shared ORS canonicalization vectors
tests/fixtures/corpus/          # 500-receipt simulation corpus
```

The monorepo is wired with npm workspaces at the root for the TypeScript
packages; the Python packages are independent distributions that each
depend on `openterms-py>=1.0.0` for canonicalization and signing.

## CI

- Python job: `pytest` against `packages/openterms-py/` — **200 passing,
  2 skipped** as of the current main (38 permissions + 162 receipts).
- The workflow is defined in [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
  and runs on every push to `main` and every pull request.
- The backend service (TypeScript API + cross-language integration tests)
  is tested in the openterms-api repository's own CI.

## Known gaps and trade-offs (SDKs)

- **Fixture corpus.** `tests/fixtures/corpus/` ships a deterministic
  500-receipt corpus (seed `5318008`, two policy versions). Regenerated
  by `packages/openterms-py/scripts/generate_corpus.py`.

Server-side gaps (webhooks, async simulation results, multi-tenant
routing, policy CRUD, production deployment) are tracked in the
openterms-api repository's `IMPLEMENTATION_STATUS.md`.
