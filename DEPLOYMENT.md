# Deployment

The openterms-trace API runs on [Render](https://render.com) for staging,
provisioned declaratively via [`render.yaml`](render.yaml) at the repo
root. The service is built from the repo-root [`Dockerfile`](Dockerfile)
(multi-stage, Node 20). Migrations and the test-workspace seed run at
server startup before Fastify begins listening. Render's free tier does
not support `preDeployCommand`, so the startup path owns this work; a
failure during either step exits non-zero and Render marks the deploy
failed rather than shifting traffic to a broken container.

This document covers staging only. Production cutover (Neon Postgres,
Redis-backed rate limit store, custom DNS, locked-down CORS) is tracked
as a separate workstream — see "Hardening for production" at the bottom.

## Architecture (staging)

```
  Internet  ──HTTPS──▶  Render web service (openterms-trace-api)
                              │
                              ▼
                       Render Postgres (openterms-trace-pg)
```

- One web service instance. Rate limiting is in-process (in-memory store).
- One managed Postgres database, joined to the web service over Render's
  private network (no public IP exposure).
- JWKS and signing material live in Render environment variables, not
  files. The container ships no key material.

## Initial provisioning

1. Push to `main`. Render auto-detects `render.yaml` and offers to create
   the blueprint. Approve.
2. Render provisions `openterms-trace-pg` and `openterms-trace-api`. The
   first deploy will fail at startup until the secrets below are set —
   this is expected.
3. In the Render dashboard for the web service, set each environment
   variable marked `sync: false` in `render.yaml`. See "Secrets" below.
4. Trigger a manual redeploy. The container starts, runs migrations,
   seeds the test workspace, then begins serving on `/healthz`. **Watch
   the first startup log** to confirm `[startup] running migrations`,
   `[startup] migrations applied: [...]`, and `[startup] running seed`
   appear before declaring the deploy healthy.
5. Run [`scripts/smoke-staging.sh`](scripts/smoke-staging.sh) against
   the staging URL to confirm the public surface is healthy.

## Secrets

All secrets are populated in the Render dashboard. Nothing here is
checked into the repo. The `loadConfig()` function at boot validates that
every required variable is set and fails fast with a single redacted
error log listing the missing variable names only — never the values of
variables that *are* set.

| Variable          | Purpose                                                                                  | How to generate                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `DATABASE_URL`    | Postgres connection string                                                               | Auto-populated by Render via `fromDatabase` in `render.yaml`                    |
| `WORKSPACE_ID`    | UUID of the seeded staging workspace                                                     | `uuidgen` — anything well-formed. Stable for the life of staging.               |
| `API_KEY_SALT`    | HMAC pepper for hashing API keys before storage. **Must be a true secret.**              | `openssl rand -hex 32`. If this leaks, rotate every API key.                    |
| `JWKS_SOURCE`     | Public JWKS, served verbatim from `/.well-known/jwks.json`                               | `memory:<urlencoded-jwks-json>` for staging. See "Key material" below.          |
| `ACTIVE_KEY_ID`   | `kid` of the signing key                                                                 | Matches the `kid` of the JWK in `JWKS_SOURCE`.                                  |
| `PRIVATE_KEY_JWK` | Ed25519 private JWK as a JSON string. Used by the signing path only; never served.       | Generate offline; never log or transmit.                                        |
| `TEST_API_KEY`    | Bearer token seeded into `api_keys` for integration tests and smoke checks.              | `ot_test_<32 bytes base32url>` — or let the seed script print one and copy it.  |
| `CORS_ORIGIN`     | CORS allowlist. `*` for staging.                                                         | Literal `*` for now; production = comma-separated list.                         |

### Why `API_KEY_SALT` matters

API keys are stored as `HMAC-SHA256(token, API_KEY_SALT)`. If an attacker
exfiltrates the `api_keys` table but not `API_KEY_SALT`, they cannot brute-
force tokens — the salt is the only thing that turns a token into the
stored hash. **Treat `API_KEY_SALT` as a top-tier secret.** Rotating it
invalidates every existing API key (all stored hashes become wrong); plan
a key re-issuance window if you rotate.

## Migrations

Migrations live under
[`apps/api/src/db/migrations/`](apps/api/src/db/migrations/) and are
copied into `apps/api/dist/db/migrations/` by the Dockerfile build step.

- The migration runner ([`apps/api/src/db/migrate.ts`](apps/api/src/db/migrate.ts))
  resolves the migrations directory from either `dist/db/migrations`
  (production) or `src/db/migrations` (dev / tests) — both paths work.
- Migrations are idempotent (`CREATE TABLE IF NOT EXISTS`), so rerunning
  is safe.
- In production (`NODE_ENV === 'production'`), `server.ts:main()` runs
  migrations and the seed at startup, before `app.listen()`. A failure
  in either step logs `[startup] migration failed:` or `[startup] seed
  failed:` and exits non-zero so Render marks the deploy failed.
- In local dev (`NODE_ENV !== 'production'`), migrations also run on
  server boot — see `server.ts:main()` — so `npm run dev` "just works"
  against a clean database. The seed is skipped in non-production.

## Test workspace seeding

[`apps/api/src/scripts/seed-test-workspace.ts`](apps/api/src/scripts/seed-test-workspace.ts)
runs at server startup in production, after migrations and before
Fastify listens. It exports `seedTestWorkspace()` for the startup path
and keeps a CLI entry point (`node apps/api/dist/scripts/seed-test-workspace.js`)
for manual reruns. It:

- Inserts the `WORKSPACE_ID` row into `workspaces` (idempotent).
- Inserts the `TEST_API_KEY` row into `api_keys` keyed by its HMAC hash
  (idempotent).
- Logs a single line with the `api_key_id` and prefix; **never** logs the
  token itself.

If `WORKSPACE_ID`, `TEST_API_KEY`, or `API_KEY_SALT` is unset, the seed
script logs a notice and exits 0 — the deploy continues. This makes the
first deploy survivable: provision secrets in the dashboard, redeploy,
the seed succeeds.

## Smoke test

[`scripts/smoke-staging.sh`](scripts/smoke-staging.sh) hits four
endpoints and asserts the expected status codes:

| Check                                          | Expected |
| ---------------------------------------------- | -------- |
| `GET /healthz`                                 | `200 {"ok":true}` |
| `GET /.well-known/jwks.json`                   | `200` with a `keys` array |
| `GET /v1/receipts` (no Authorization)          | `401 UNAUTHORIZED`           |
| `GET /v1/receipts` (with `TEST_API_KEY`)       | `200`                        |

Run it after every deploy:

```bash
STAGING_URL=https://openterms-trace-api.onrender.com \
TEST_API_KEY=ot_test_… \
./scripts/smoke-staging.sh
```

## Running the integration tests against staging

The in-process integration tests under `apps/api/tests/` boot the Fastify
app in the same process. To exercise the deployed surface end-to-end,
point a fresh test run at the staging URL using a bearer token issued by
the seed script:

```bash
STAGING_URL=https://openterms-trace-api.onrender.com \
TEST_API_KEY=ot_test_… \
./scripts/smoke-staging.sh
```

A full SDK round-trip (sign → POST → verify) requires the Python SDK
configured with the same `TEST_API_KEY`. See
[`tests/integration/test_adapter_e2e.py`](tests/integration/test_adapter_e2e.py)
for the local-loop version; the staging variant is a follow-up.

## Local Docker build verification

Before pushing, verify the image builds locally:

```bash
docker build -t openterms-trace-api .
```

This catches the npm-workspaces + multi-stage interaction (SDK must build
before API) before Render's slower remote builder sees it.

## CORS

Staging uses `Access-Control-Allow-Origin: *`. Rationale: CORS is browser-
enforced, non-browser clients ignore it, and the browser-based attack
surface is zero until the Polsia dashboard at `observe.openterms.com`
ships. When the dashboard exists, switch `CORS_ORIGIN` to a comma-
separated allowlist of dashboard origins.

## Hardening for production

The following are explicitly deferred and tracked here for the production
cutover:

- **Database**: migrate from Render Postgres to Neon (per
  `LLM_Handoff_Brief.md` §6) with a read replica.
- **Rate limit store**: replace in-memory with Redis so limits hold
  across multiple instances.
- **CORS**: replace `*` with an allowlist (dashboard + known SDK web
  clients).
- **Custom DNS**: switch from `*.onrender.com` to
  `api-staging.openterms.com` / `api.openterms.com`, with cert via Render.
- **Key custody**: move `PRIVATE_KEY_JWK` from a plain env var to a KMS
  envelope (AWS KMS, GCP KMS, or Render's secret-encryption when
  available).
- **JWKS publication**: serve from a CDN with a longer max-age and
  signed-URL invalidation for rotation events.
- **Verify endpoint**: when `GET /v1/receipts/{hash}/verify` ships,
  register it with `PUBLIC_ROUTE` so unauthenticated third parties can
  verify a receipt without a bearer token. The route does not exist yet
  in this build.

## File map

- [`render.yaml`](render.yaml) — Blueprint: web service + database + envs.
- [`Dockerfile`](Dockerfile) — multi-stage build.
- [`.dockerignore`](.dockerignore) — context exclusions.
- [`apps/api/src/db/migrations/`](apps/api/src/db/migrations/) — SQL migrations.
- [`apps/api/src/scripts/seed-test-workspace.ts`](apps/api/src/scripts/seed-test-workspace.ts) — idempotent seed.
- [`apps/api/src/auth/bearer.ts`](apps/api/src/auth/bearer.ts) — bearer-auth Fastify hook.
- [`apps/api/src/routes/jwks.ts`](apps/api/src/routes/jwks.ts) — `/.well-known/jwks.json` handler.
- [`scripts/smoke-staging.sh`](scripts/smoke-staging.sh) — post-deploy smoke.
