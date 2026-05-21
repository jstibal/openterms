# Docs Handoff for Polsia

**Source build:** `openterms-trace` at commit `01ebde5` (end of BUILD_BRIEF Step 10).
**Source of truth for capabilities:** [`IMPLEMENTATION_STATUS.md`](../IMPLEMENTATION_STATUS.md) (see calibration note in Section 7 — this file is stale and needs to be updated before the docs go live), the four package READMEs under [`packages/`](../packages/), [`openapi.yaml`](../openapi.yaml), and [`DEPLOYMENT.md`](../DEPLOYMENT.md).
**Target docs surface:** `observe.openterms.com/docs`, managed by Polsia. This handoff does not modify the Polsia surface; it captures the updates Polsia needs to apply.

---

## Section 1 — Overview of changes

The conventional track of `openterms-trace` is now feature-complete through BUILD_BRIEF Step 10. The Fastify API service accepts signed ORS v0.1 / v0.2 receipts, verifies Ed25519 signatures against a hosted JWKS, persists receipts to an append-only Postgres log, evaluates a deterministic policy engine on every ingest, supports cursor-paginated query of receipts and decisions, runs synchronous policy simulations against the corpus, and is deployed behind bearer-token auth with per-workspace rate limiting and a public `/.well-known/jwks.json` endpoint. Four SDK packages are prepared for publication: `openterms` (PyPI), `@openterms/sdk` (npm), `openterms-langchain` (PyPI), `openterms-crewai` (PyPI). The docs updates below land the SDK install/quickstart content, the API response schemas, the simulation schema, the key rotation procedure, and the ORS test-vector link, and they leave explicit gap markers for webhooks (not implemented), regulatory context (pending), SLA terms (pending), and several openapi.yaml endpoints that are documented in the contract but not yet implemented in the service (policies CRUD, keys CRUD, workspace, public verify, webhook test). The docs must not overstate any of these. The calibrated truth in [`IMPLEMENTATION_STATUS.md`](../IMPLEMENTATION_STATUS.md) (once refreshed against this commit) is the binding reference.

---

## Section 2 — Page-by-page updates

The 17 pages below match the Polsia information architecture in use at `observe.openterms.com/docs`. For each page: current state, updates required, and exact text to paste. Wherever a real URL is needed, the placeholder `{{STAGING_URL}}` appears — see Section 6 for the full substitution list.

### 2.1 — `/docs/` (Introduction / Landing)

**Current state.** Generic overview; refers to SDK packages as "coming soon."

**Updates needed.** Replace the "coming soon" callout with the four real package names, link to install pages, and add a one-line capability summary that matches the current build (ingest + verify + query + simulate, plus public JWKS). Add an explicit "what is not yet in the service" callout to keep the page honest.

**Exact text to apply.**

```markdown
# OpenTerms Agent Action Observability

OpenTerms ingests, verifies, and persists cryptographically signed receipts of
agent tool calls. Every receipt conforms to the [Open Receipt Specification
(ORS)](https://github.com/jstibal/ors-spec). Receipts are signed with Ed25519,
canonicalized per RFC 8785, and stored on an append-only log. A deterministic
policy engine evaluates each receipt at ingest time.

## What ships today

- **Ingest API** — `POST /v1/receipts/ingest` accepts a signed receipt,
  verifies the signature against the workspace JWKS, evaluates the active
  policy, and persists both the receipt and the decision.
- **Query API** — list receipts and decisions with cursor pagination,
  filtered by agent, action type, tool, decision outcome, time window.
- **Simulation API** — `POST /v1/simulate` replays a candidate policy
  against the historical corpus and returns counterfactual diffs.
- **Public JWKS** — `GET /.well-known/jwks.json` is CORS-open and
  edge-cached for 24 hours so any third party can verify receipts
  independently.
- **SDKs** — Python (`openterms`), TypeScript (`@openterms/sdk`),
  LangChain adapter (`openterms-langchain`), CrewAI adapter
  (`openterms-crewai`).

## What is not yet in the service

The OpenAPI contract describes a larger surface than the current build
exposes. The following are documented as **planned** and return 404 in the
current deploy:

- Policy CRUD (`/v1/policies`, `/v1/policy/evaluate`, policy activation)
- Key management endpoints (`/v1/keys`, `/v1/keys/rotate`)
- Workspace configuration endpoints (`/v1/workspace`)
- Webhook delivery and test endpoints (`/v1/webhooks/test`)
- Public verification endpoint (`/v1/receipts/verify/{hash}`)
- OAuth2 authorization-code flow (bearer-token auth is the only scheme
  currently enforced)

See [Implementation Status](https://github.com/jstibal/openterms-trace/blob/main/IMPLEMENTATION_STATUS.md)
for the authoritative reference.
```

---

### 2.2 — `/docs/quickstart`

**Current state.** Placeholder; refers to install instructions "to be added when SDK exists."

**Updates needed.** Real install + first-receipt example for both Python and TypeScript, against the staging URL.

**Exact text to apply.** See Section 5.1 (Python) and 5.2 (TypeScript) for the full code samples this page should embed. Use this preamble:

```markdown
# Quickstart

Get a signed receipt landed in OpenTerms in under five minutes.

## Prerequisites

- Python 3.10+ or Node.js 18+
- A workspace API key (`ot_test_…` or `ot_live_…`). Contact
  [support@openterms.com](mailto:support@openterms.com) for staging access.

## Pick your SDK

- [Python (`openterms`)](#python) — covered below.
- [TypeScript (`@openterms/sdk`)](#typescript) — covered below.
- [LangChain (`openterms-langchain`)](/docs/integrations/langchain).
- [CrewAI (`openterms-crewai`)](/docs/integrations/crewai).
```

(Then paste the Python sample from Section 5.1 and the TypeScript sample from Section 5.2.)

---

### 2.3 — `/docs/concepts/receipts`

**Current state.** Describes the abstract ORS receipt; defers signed-envelope and v0.2 optional-field details.

**Updates needed.** Document the three field groups (payload, envelope, signature metadata) explicitly. Reference the canonicalization vectors.

**Exact text to apply.**

```markdown
# Receipts

A receipt is a single flat JSON object containing three groups of fields:

1. **Payload fields (signed, canonicalized).** `workspace_id`, `agent_id`,
   `action_type`, `terms_url`, `terms_hash`, `timestamp`, `pricing_version`,
   plus optional `action_context`, `ors_version`, `issuer`, `provider`,
   `decision`, `request_binding`, and the ORS v0.2 optional fields
   `terms_type`, `terms_service`, `terms_version`.
2. **Signed envelope fields (also canonicalized).** `receipt_id`,
   `amount_charged`, `created_at`.
3. **Signature metadata (not canonicalized).** `canonical_hash`,
   `signature`, `key_id`. These are outputs of the signing process and
   are added after the canonical hash is computed.

Canonicalization is RFC 8785 with one additional rule: any key whose value
is `null` (at any nesting level) is removed before serialization. The
Ed25519 signature is over `b"ORSv0.1\x00"` concatenated with the raw
32-byte SHA-256 hash of the canonical bytes (40 bytes total).

ORS v0.2 is fully backward compatible with v0.1 — the signing prefix is
unchanged. A receipt with v0.2 optional fields verifies as v0.1 by readers
that ignore those fields.

## Test vectors

The reference canonicalization vectors (12 spec vectors plus 4 corner
cases) ship in the repository at
[`tests/vectors/ors-v0.1/canonicalization.json`](https://github.com/jstibal/openterms-trace/blob/main/tests/vectors/ors-v0.1/canonicalization.json).
Both the Python and TypeScript SDKs are verified against these vectors in
CI; any compliant ORS implementation should pass them.
```

---

### 2.4 — `/docs/concepts/policies-and-decisions`

**Current state.** Describes rule types; treats policy CRUD as if it shipped.

**Updates needed.** Remove implied policy-CRUD references. State explicitly that the active policy is currently hardcoded server-side and that policy CRUD is on the roadmap. Document the rule-type enum.

**Exact text to apply.**

```markdown
# Policies and decisions

The policy engine evaluates each receipt deterministically at ingest time
and writes a decision to the decisions table. The same
`(policy_version, receipt)` input always produces the same decision.

## Decision outcomes

- `allow` — the receipt passes the active policy.
- `deny` — at least one rule fired with outcome `deny`. The receipt is
  still persisted; the decision records the firing rule and reasons.
- `escalate` — at least one rule fired with outcome `escalate`. Receipt
  is persisted.

A pattern-evaluation timeout in `args_pattern_match` surfaces as
`decision = deny` with reason `TIMEOUT` rather than an HTTP error. A
policy-engine failure that prevents producing a decision surfaces as a
stored `deny` with reason `ENGINE_ERROR`; the receipt is still persisted.

## Supported rule types

| Type | Effect |
| ---- | ------ |
| `max_amount` | Deny if `amount_charged` exceeds the configured ceiling. |
| `daily_limit` | Deny if cumulative `amount_charged` per agent per day exceeds the configured ceiling. |
| `action_type_allowlist` | Deny if `action_type` is not in the allowlist. |
| `action_type_denylist` | Deny if `action_type` is in the denylist. |
| `url_prefix_allowlist` | Deny if `terms_url` does not start with one of the listed prefixes. |
| `url_prefix_denylist` | Deny if `terms_url` starts with one of the listed prefixes. |
| `escalation_threshold` | Escalate if `amount_charged` exceeds the configured threshold. |
| `tool_id_allowlist` | Deny if `action_context.ors.commitments.tool_id` is not in the allowlist. |
| `args_pattern_match` | Deny if a regex matches the args. Bounded to <5 ms p99. |
| `post_state_assertion` | Deny if a post-action receipt's `post_state_hash` is absent or unexpected. |

## Policy management (status)

**The active policy is currently hardcoded in the service.** Runtime policy
updates require redeploy. The OpenAPI contract documents
`POST /v1/policies`, `PATCH /v1/policies/{id}/activate`, and
`POST /v1/policy/evaluate`; **these endpoints are not yet implemented and
return 404 in the current deploy.** Policy CRUD is on the roadmap.
```

---

### 2.5 — `/docs/concepts/simulation`

**Current state.** Marked "to be added when simulator exists."

**Updates needed.** Document the simulate endpoint, the request shape, the result shape, the sync threshold, the deterministic-sample behavior.

**Exact text to apply.**

```markdown
# Simulation

`POST /v1/simulate` replays a candidate policy against the historical
receipt corpus for a specified time window. It returns counterfactual
decision counts, a diff against the decisions actually recorded in the
period, and a deterministic sample of receipts where the counterfactual
differs.

Simulation is read-only on the receipt corpus. It never modifies a stored
decision or affects live agent behavior.

## Request shape

```json
{
  "candidate_policy": {
    "name": "stricter-allowlist",
    "rules": [
      { "id": "r1", "type": "max_amount", "outcome": "deny",
        "parameters": { "ceiling": 5000 } }
    ]
  },
  "from": "2026-04-01T00:00:00Z",
  "to":   "2026-05-01T00:00:00Z",
  "sample_size": 100
}
```

`candidate_policy` accepts an inline `PolicyInput` object today. Passing a
policy-version ID string is documented in the OpenAPI contract but is
**not yet implemented** (returns 400). Policy IDs ship when policy CRUD
ships.

## Response shape

```json
{
  "counterfactual_counts": { "allow": 412, "deny": 78, "escalate": 10 },
  "actual_counts":         { "allow": 420, "deny": 70, "escalate": 10 },
  "diff_summary": {
    "total_diffs": 8,
    "by_rule": { "r1": 8 },
    "by_tool": { "search": 5, "purchase": 3 }
  },
  "sample": [
    {
      "receipt_hash": "…",
      "actual_decision": "allow",
      "counterfactual_decision": "deny",
      "counterfactual_reasons": ["r1: amount_charged exceeds ceiling"]
    }
  ],
  "evaluated_at": "2026-05-21T18:00:00.000Z",
  "receipts_evaluated": 500
}
```

The `sample` is deterministic — re-running the same simulation input
returns the same sample order.

## Synchronous vs. asynchronous

The current build runs simulation synchronously for any corpus under 10,000
receipts (every supported corpus in the current deploy). Larger corpora
will return `202` with a `job_id` polled via `GET /v1/simulate/{job_id}`;
the async path is wired in the route layer but the queue worker is not
implemented today, so the 202 path is not reachable in the current deploy.
```

---

### 2.6 — `/docs/api/overview`

**Current state.** Says "API reference to be added."

**Updates needed.** Replace with a single page that lists every implemented endpoint, marks the planned ones, and links to the full OpenAPI document.

**Exact text to apply.**

```markdown
# API overview

Base URL: `{{STAGING_URL}}` (staging). Production cutover pending.

All `/v1/*` endpoints require `Authorization: Bearer <api_key>` unless
otherwise marked. `/healthz` and `/.well-known/jwks.json` are public.

## Implemented endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/healthz` | Liveness probe. Public. |
| GET    | `/.well-known/jwks.json` | Public JWKS. CORS-open, 24h max-age. |
| POST   | `/v1/receipts/ingest` | Ingest a signed receipt. |
| GET    | `/v1/receipts` | List receipts with filters and cursor pagination. |
| GET    | `/v1/receipts/{hash}` | Get one receipt by canonical hash. |
| GET    | `/v1/decisions` | List decisions, joined to receipts. |
| POST   | `/v1/simulate` | Replay a candidate policy (synchronous). |
| GET    | `/v1/simulate/{job_id}` | Poll an async simulation job (stub — see Simulation page). |

## Planned endpoints (documented in OpenAPI; not yet served)

| Method | Path | Status |
| ------ | ---- | ------ |
| GET    | `/v1/receipts/verify/{hash}` | Public verify — not implemented. |
| GET    | `/v1/policies` | Policy CRUD — not implemented. |
| POST   | `/v1/policies` | Policy CRUD — not implemented. |
| PATCH  | `/v1/policies/{id}/activate` | Policy CRUD — not implemented. |
| POST   | `/v1/policy/evaluate` | Stateless policy evaluation — not implemented. |
| GET    | `/v1/keys` | Key management — not implemented. |
| POST   | `/v1/keys/rotate` | Key rotation HTTP endpoint — not implemented (operational procedure documented). |
| GET    | `/v1/workspace` | Workspace config — not implemented. |
| PATCH  | `/v1/workspace` | Workspace config — not implemented. |
| POST   | `/v1/webhooks/test` | Webhook delivery — not implemented. |

The full machine-readable contract is in
[openapi.yaml](https://github.com/jstibal/openterms-trace/blob/main/openapi.yaml).
Endpoints in the contract that are not yet served return `404` today.
```

---

### 2.7 — `/docs/api/authentication`

**Current state.** Says "auth to be added."

**Updates needed.** Document bearer-token auth, key prefixes, dev fallback (off in production), and the `WWW-Authenticate` semantics.

**Exact text to apply.**

```markdown
# Authentication

All `/v1/*` endpoints require an `Authorization: Bearer <api_key>` header.
API keys are workspace-scoped.

## Token format

- Live keys are prefixed `ot_live_`.
- Test keys are prefixed `ot_test_`.

Anything not matching that prefix is rejected with `401`.

## Storage

API keys are stored as `HMAC-SHA256(token, API_KEY_SALT)`. The plaintext
token is never logged and never written to the database. If you lose a
key, you must rotate it — there is no recovery path.

## Error responses

| Code | Status | Meaning |
| ---- | ------ | ------- |
| `UNAUTHORIZED` | 401 | No `Authorization` header. |
| `INVALID_TOKEN` | 401 | Token format invalid or not found. |
| `REVOKED` | 401 | Token was issued but has been revoked. |

The server emits `WWW-Authenticate: Bearer realm="openterms"` on 401.

OAuth2 (authorization-code flow) is documented in the OpenAPI contract
but **not yet implemented**. The only currently enforced scheme is
bearer-token.
```

---

### 2.8 — `/docs/api/receipts-ingest`

**Current state.** Stubbed; refers to "response schemas to be added when API ships."

**Updates needed.** Full request/response cycle with examples.

**Exact text to apply.**

```markdown
# POST /v1/receipts/ingest

Accepts a signed ORS receipt (v0.1 or v0.2). The service:

1. Validates the receipt against the ORS payload schema.
2. Recomputes the canonical hash and compares to `canonical_hash`.
3. Looks up the public key by `key_id` in the workspace JWKS.
4. Verifies the Ed25519 signature over `b"ORSv0.1\x00" + hash_bytes`.
5. Deduplicates by `canonical_hash` (idempotent).
6. Persists the verified receipt and the engine decision.

Receipts that fail schema, hash, or signature verification are **not**
written to the receipts table; failures log to a separate
`verification_errors` table.

## Request

```http
POST /v1/receipts/ingest HTTP/1.1
Host: {{STAGING_URL_HOST}}
Authorization: Bearer ot_test_…
Content-Type: application/json
Idempotency-Key: optional-client-supplied-key

{ /* SignedReceipt — see Receipts concept */ }
```

## Responses

### 201 Created

Receipt accepted and persisted.

```json
{
  "hash": "d486a0a0d298a91b52544aea298693f0ea3584d5f808955d7c09d5f99c16ee32",
  "ingested_at": "2026-05-21T18:01:00.000Z",
  "duplicate": false,
  "receipt": { /* echo of stored receipt */ },
  "decision": {
    "decision": "allow",
    "triggered_rules": [],
    "reasons": [],
    "policy_version": "hardcoded-v1",
    "evaluated_at": "2026-05-21T18:01:00.000Z"
  }
}
```

### 200 OK (idempotent replay)

Same body shape as 201; `duplicate: true`.

### 4xx errors

| Status | `error.code` | Meaning |
| ------ | ------------ | ------- |
| 400 | `VALIDATION_ERROR` | Receipt missing a required field or wrong type. |
| 401 | `UNAUTHORIZED` / `INVALID_TOKEN` / `REVOKED` | See [Authentication](/docs/api/authentication). |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` | Same `Idempotency-Key`, different payload. |
| 422 | `HASH_MISMATCH` | Recomputed canonical hash ≠ supplied `canonical_hash`. |
| 422 | `SIGNATURE_INVALID` | Ed25519 verify failed. |
| 422 | `UNKNOWN_ISSUER` | `key_id` not in the workspace JWKS. |
| 429 | `RATE_LIMIT_EXCEEDED` | See [Rate limits](/docs/api/rate-limits). |
```

---

### 2.9 — `/docs/api/receipts-query`

**Current state.** Lists filters but no examples; response schema "to be added."

**Updates needed.** Full filter list, cursor pagination model, full response example.

**Exact text to apply.**

```markdown
# GET /v1/receipts and GET /v1/receipts/{hash}

## List receipts

`GET /v1/receipts` returns a cursor-paginated page of receipts in the
authenticated workspace.

### Query parameters

| Name | Type | Notes |
| ---- | ---- | ----- |
| `agent_id` | string | Filter by agent identifier. |
| `action_type` | enum | One of `api_call`, `data_access`, `purchase`, `custom`, `model_training`. |
| `tool_id` | string | Reads `action_context.ors.commitments.tool_id`. |
| `decision` | enum | `allow` / `deny` / `escalate`. |
| `from`, `to` | ISO-8601 | Inclusive `timestamp` bounds. |
| `limit` | int | 1–200, default 50. |
| `cursor` | string | Opaque cursor from the previous page's `next_cursor`. |

### Response

```json
{
  "receipts": [
    {
      "receipt": { /* SignedReceipt */ },
      "hash": "d486a0a0…",
      "ingested_at": "2026-05-21T18:01:00.000Z",
      "decision": {
        "decision": "allow",
        "triggered_rules": [],
        "reasons": [],
        "policy_version": "hardcoded-v1",
        "evaluated_at": "2026-05-21T18:01:00.000Z"
      }
    }
  ],
  "next_cursor": "eyJ0aW1lc3RhbXAi…"
}
```

`next_cursor` is `null` on the last page. The cursor is stable under
concurrent inserts (ordered by `(timestamp, receipt_id)`).

> **Note.** The aggregation modes (`count_by_decision` etc.), the `q`
> full-text filter, the `triggered_rule`/`chain_id`/`issuer` filters
> appear in the OpenAPI contract. The currently implemented filters are
> the ones listed above; the others are planned.

## Get one receipt

`GET /v1/receipts/{hash}` returns a single receipt plus its decision.

```json
{
  "receipt": { /* SignedReceipt */ },
  "hash": "d486a0a0…",
  "ingested_at": "2026-05-21T18:01:00.000Z",
  "decision": { /* … or null */ }
}
```

`404` if the hash is not found in the authenticated workspace.
```

---

### 2.10 — `/docs/api/decisions`

**Current state.** Placeholder.

**Updates needed.** Document `GET /v1/decisions` with the same filter+cursor model as receipts plus `policy_version`.

**Exact text to apply.**

```markdown
# GET /v1/decisions

Lists policy decisions for the workspace. Decisions are joined to their
parent receipts; pagination matches `/v1/receipts`.

### Query parameters

Supports `agent_id`, `action_type`, `tool_id`, `decision`,
`from`, `to`, `limit`, `cursor` (same semantics as
[`/v1/receipts`](/docs/api/receipts-query)), plus:

| Name | Type | Notes |
| ---- | ---- | ----- |
| `policy_version` | string | Filter to decisions made under a specific policy version. |

### Response

```json
{
  "decisions": [
    {
      "decision": "deny",
      "triggered_rules": ["r1"],
      "reasons": ["r1: amount_charged exceeds ceiling"],
      "policy_version": "hardcoded-v1",
      "evaluated_at": "2026-05-21T18:01:00.000Z",
      "receipt_hash": "d486a0a0…"
    }
  ],
  "next_cursor": null
}
```
```

---

### 2.11 — `/docs/api/simulate`

**Current state.** Placeholder.

**Updates needed.** Document `POST /v1/simulate` and the `GET /v1/simulate/{job_id}` stub. Reuse the concept-page schema.

**Exact text to apply.** See concept page 2.5. The API reference page should restate the request and response examples and add this status note at the top:

```markdown
> **Sync only in the current build.** Corpora over 10,000 receipts will
> route through an async queue (202 + job polling). The async worker is
> not yet implemented; the synchronous path covers every corpus in the
> current deploy.
```

---

### 2.12 — `/docs/api/jwks`

**Current state.** Marked "to be added when JWKS is hosted."

**Updates needed.** Document the now-real endpoint, cache headers, key format.

**Exact text to apply.**

```markdown
# GET /.well-known/jwks.json

Public key distribution per RFC 7517. CORS-open, no authentication
required.

```http
GET /.well-known/jwks.json HTTP/1.1
Host: {{STAGING_URL_HOST}}
```

### Response

```http
HTTP/1.1 200 OK
Content-Type: application/jwk-set+json; charset=utf-8
Cache-Control: public, max-age=86400, stale-while-revalidate=3600
```

```json
{
  "keys": [
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "kid": "key_2026_05_…",
      "use": "sig",
      "alg": "EdDSA",
      "x": "<base64url Ed25519 public key, 43 chars>"
    }
  ]
}
```

Both active and inactive keys remain in the JWKS indefinitely so receipts
signed under prior keys continue to verify.

The full JWKS URL on staging is `{{STAGING_URL}}/.well-known/jwks.json`.
```

---

### 2.13 — `/docs/api/rate-limits`

**Current state.** "Limits to be confirmed."

**Updates needed.** Real defaults plus the `RateLimit-*` headers.

**Exact text to apply.**

```markdown
# Rate limits

Per-workspace limits, enforced per minute. Defaults:

| Surface | Default (req/min) |
| ------- | ----------------- |
| Query and read endpoints | 120 |
| Ingest endpoint | 600 |
| Public endpoints (per IP) | 60 |

Every response carries draft-7 headers:

- `x-ratelimit-limit`
- `x-ratelimit-remaining`
- `x-ratelimit-reset`

A 429 response carries `Retry-After` (seconds).

The rate-limit store is in-process today. Horizontal scale-out will
introduce a Redis store; the limit values above are stable across that
change.
```

---

### 2.14 — `/docs/integrations/python-sdk`

**Current state.** Says "SDK to be packaged."

**Updates needed.** Real install + quickstart from [packages/openterms-py/README.md](../packages/openterms-py/README.md). Include the v0.2 optional-field example.

**Exact text to apply.** Use the package README content verbatim. Specifically, the install block:

```markdown
## Install

```bash
pip install openterms
```

Runtime dependency: `cryptography>=42`. The SDK uses `urllib.request` from
the standard library — no HTTP client dependency.
```

And the full quickstart from [packages/openterms-py/README.md](../packages/openterms-py/README.md) lines 13–82. Add a "Verifying receipts" subsection with the offline-verify example. Replace `http://localhost:3000` with `{{STAGING_URL}}` in the docs version.

---

### 2.15 — `/docs/integrations/typescript-sdk`

**Current state.** Says "SDK to be packaged."

**Updates needed.** Use [packages/openterms-ts/README.md](../packages/openterms-ts/README.md) verbatim. Real npm package is `@openterms/sdk`.

**Exact text to apply.** Install + quickstart from the package README. Replace `http://localhost:3000` with `{{STAGING_URL}}`.

```markdown
## Install

```bash
npm install @openterms/sdk
```

Runtime dependencies: `@noble/ed25519`, `@noble/hashes`. Uses the global
`fetch` (Node 18+).
```

---

### 2.16 — `/docs/integrations/langchain`

**Current state.** Says "adapter to be packaged."

**Updates needed.** Replace with the content from [packages/langchain-openterms/README.md](../packages/langchain-openterms/README.md), including the `OpenTermsCallbackHandler` example and the `emit_post_action` / `strict` configuration knobs. See Section 5.3 for the full embedded sample.

**Install block.**

```markdown
## Install

```bash
pip install openterms-langchain
```

Pulls in `langchain-core>=0.3,<1.0`. Uses only the public
`BaseCallbackHandler` hooks.
```

---

### 2.17 — `/docs/integrations/crewai`

**Current state.** Says "adapter to be packaged."

**Updates needed.** Use [packages/crewai-openterms/README.md](../packages/crewai-openterms/README.md). Stress that CrewAI itself is not a hard runtime dependency. See Section 5.4 for the full embedded sample.

**Install block.**

```markdown
## Install

```bash
pip install openterms-crewai
```

CrewAI itself is not a runtime dependency. The adapter wraps a plain
callable; plug the wrapped function into CrewAI the way your project
already does (`Tool(name=..., func=...)`, the `@tool` decorator, or as
the body of a `BaseTool._run`).
```

---

## Section 3 — New pages to add

The following pages do not yet exist in the docs surface and should be created.

### 3.1 — `/docs/operations/key-rotation`

**Why new.** The repo does not yet ship a hosted key-rotation procedure document (see calibration item in Section 7 — the prompt referenced `docs/security/secrets-handling.md`, which does not exist in this build). Until that file ships, the docs need a self-contained page so customers know the boundary.

**Full content.**

```markdown
# Key rotation

OpenTerms signs receipts with Ed25519. Key rotation is **operator-driven
in the current build** — there is no `POST /v1/keys/rotate` HTTP endpoint
yet (it appears in the OpenAPI contract as planned).

## Current rotation procedure (staging)

1. Generate a new Ed25519 keypair offline.
2. Build a JWKS document containing the current public key **and** the
   new public key. Both must remain published so receipts under the prior
   key continue to verify.
3. Update the deployment environment variables:
   - `JWKS_SOURCE` → new JWKS JSON (or `memory:<urlencoded-json>`).
   - `ACTIVE_KEY_ID` → the `kid` of the new key.
   - `PRIVATE_KEY_JWK` → the new private JWK.
4. Trigger a redeploy. New receipts are signed under the new key; verifiers
   resolve both keys via the public JWKS for the lifetime of receipts
   signed under the prior key.
5. The previous key is retained in the JWKS indefinitely — there is no
   removal procedure today. Removing a key invalidates the verifiability
   of every historical receipt signed under it, which is undesirable.

## Verification clients

Verifiers that cache JWKS responses must honor the
`Cache-Control: max-age=86400` directive. Worst-case rotation propagation
to a long-lived verifier client is therefore 24 hours; receipts continue
to verify under the prior key throughout this window.

## What is not yet in place

- `POST /v1/keys/rotate` admin endpoint (planned).
- KMS-backed private key custody. Today private keys live in deployment
  environment variables. A KMS envelope is on the production-cutover
  roadmap.
- Automated rotation scheduling.
```

### 3.2 — `/docs/operations/staging`

**Why new.** Customers need a quick reference for the staging URL, the test API key flow, and the smoke-test scripts.

**Full content.**

```markdown
# Staging environment

- API base URL: `{{STAGING_URL}}`
- JWKS URL: `{{STAGING_URL}}/.well-known/jwks.json`
- Health: `{{STAGING_URL}}/healthz` (public)

## Test API keys

Test tokens are prefixed `ot_test_`. Contact
[support@openterms.com](mailto:support@openterms.com) for a staging key.
Test tokens are workspace-scoped and behave identically to live tokens —
the only difference is the prefix, which simplifies log redaction.

## Smoke test

After every staging deploy:

```bash
STAGING_URL={{STAGING_URL}} \
TEST_API_KEY=ot_test_… \
./scripts/smoke-staging.sh
```

The script asserts:

| Check | Expected |
| ----- | -------- |
| `GET /healthz` | `200 {"ok":true}` |
| `GET /.well-known/jwks.json` | `200` with `keys` array |
| `GET /v1/receipts` (no auth) | `401 UNAUTHORIZED` |
| `GET /v1/receipts` (with `TEST_API_KEY`) | `200` |
```

### 3.3 — `/docs/reference/test-vectors`

**Why new.** ORS interop requires a published vector reference.

**Full content.**

```markdown
# Canonicalization test vectors

ORS canonicalization is RFC 8785 plus the null-stripping rule. The
reference test vectors (12 spec vectors plus 4 corner cases) are
published in the openterms-trace repository at
[`tests/vectors/ors-v0.1/canonicalization.json`](https://github.com/jstibal/openterms-trace/blob/main/tests/vectors/ors-v0.1/canonicalization.json).

Both the Python and TypeScript SDKs are checked against these vectors in
CI. Any compliant ORS implementation should pass them. If your
implementation fails a vector, file an issue against the SDK repository
with the failing vector name.
```

---

## Section 4 — Pages to remove or merge

| Current page | Action | Rationale |
| ------------ | ------ | --------- |
| `/docs/coming-soon` (if present) | Remove | Every "coming soon" SDK section now has real content. |
| `/docs/concepts/dashboard` (placeholder for Polsia UI) | Keep but mark as Polsia-managed | The OpenTerms API does not ship a dashboard; the Polsia surface owns this. |
| Any page that claims OAuth2 is available | Remove or rewrite | OAuth2 is documented in the OpenAPI contract but **not implemented**. Bearer-token is the only enforced scheme. |
| Any page that documents `POST /v1/policies` / `POST /v1/keys/rotate` / `GET /v1/workspace` / `POST /v1/webhooks/test` as available | Move to a "Planned" section | These endpoints return 404 today. |

---

## Section 5 — Code samples

Each sample is self-contained: install commands, environment setup, code, expected output. All samples use `{{STAGING_URL}}` and `ot_test_…` placeholders.

### 5.1 — Python: sign and emit a receipt

```bash
pip install openterms
export OPENTERMS_API_URL={{STAGING_URL}}
export OPENTERMS_API_KEY=ot_test_…
export OPENTERMS_WORKSPACE_ID=00000000-0000-4000-8000-0000000000aa
```

```python
import os
from openterms import IngestClient, generate_keypair

sk, _pk = generate_keypair()  # for prototyping only — own your keys in real use
private_seed = sk.private_bytes_raw()

client = IngestClient(
    base_url=os.environ["OPENTERMS_API_URL"],
    api_key=os.environ["OPENTERMS_API_KEY"],
    workspace_id=os.environ["OPENTERMS_WORKSPACE_ID"],
    key_id="my-key",
    private_key=private_seed,
    agent_id="quickstart-agent",
)

response = client.emit_receipt(
    action_type="tool_call",
    terms_url="https://example.com/terms",
    terms_hash="a" * 64,
    action_context={"tool_id": "search", "args": {"q": "hello"}},
)
print(response.canonical_hash, response.duplicate)
```

**Expected output:**

```
<64-hex-canonical-hash> False
```

### 5.2 — TypeScript: sign and emit a receipt

```bash
npm install @openterms/sdk
export OPENTERMS_API_URL={{STAGING_URL}}
export OPENTERMS_API_KEY=ot_test_…
export OPENTERMS_WORKSPACE_ID=00000000-0000-4000-8000-0000000000aa
```

```typescript
import { IngestClient } from '@openterms/sdk';
import { randomBytes } from 'node:crypto';

const privateKey = randomBytes(32);

const client = new IngestClient({
  baseUrl: process.env.OPENTERMS_API_URL!,
  apiKey: process.env.OPENTERMS_API_KEY!,
  workspaceId: process.env.OPENTERMS_WORKSPACE_ID!,
  keyId: 'my-key',
  privateKey,
  agentId: 'quickstart-agent',
});

const response = await client.emitReceipt({
  actionType: 'tool_call',
  termsUrl: 'https://example.com/terms',
  termsHash: 'a'.repeat(64),
  actionContext: { tool_id: 'search', args: { q: 'hello' } },
});
console.log(response.canonicalHash, response.duplicate);
```

**Expected output:**

```
<64-hex-canonical-hash> false
```

### 5.3 — LangChain integration

```bash
pip install openterms openterms-langchain langchain-core
export OPENTERMS_API_URL={{STAGING_URL}}
export OPENTERMS_API_KEY=ot_test_…
export OPENTERMS_WORKSPACE_ID=00000000-0000-4000-8000-0000000000aa
```

```python
import os
from langchain_core.tools import tool
from openterms import IngestClient, generate_keypair
from openterms_langchain import OpenTermsCallbackHandler

sk, _ = generate_keypair()
client = IngestClient(
    base_url=os.environ["OPENTERMS_API_URL"],
    api_key=os.environ["OPENTERMS_API_KEY"],
    workspace_id=os.environ["OPENTERMS_WORKSPACE_ID"],
    key_id="my-key",
    private_key=sk.private_bytes_raw(),
    agent_id="lc-agent",
)
handler = OpenTermsCallbackHandler(
    client=client,
    agent_id="lc-agent",
    terms_url="https://example.com/terms",
    terms_hash="a" * 64,
    emit_post_action=True,
)

@tool
def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b

print(add.invoke({"a": 2, "b": 3}, config={"callbacks": [handler]}))
```

**Expected output:**

```
5
```

Two receipts are POSTed to OpenTerms: one on `on_tool_start` (args = `{a:2, b:3}`), one on `on_tool_end` with `post_state_hash` = SHA-256 of `"5"`.

### 5.4 — CrewAI integration

```bash
pip install openterms openterms-crewai
export OPENTERMS_API_URL={{STAGING_URL}}
export OPENTERMS_API_KEY=ot_test_…
export OPENTERMS_WORKSPACE_ID=00000000-0000-4000-8000-0000000000aa
```

```python
import os
from openterms import IngestClient, generate_keypair
from openterms_crewai import OpenTermsToolConfig, wrap_tool

sk, _ = generate_keypair()
client = IngestClient(
    base_url=os.environ["OPENTERMS_API_URL"],
    api_key=os.environ["OPENTERMS_API_KEY"],
    workspace_id=os.environ["OPENTERMS_WORKSPACE_ID"],
    key_id="my-key",
    private_key=sk.private_bytes_raw(),
    agent_id="crew-agent",
)
config = OpenTermsToolConfig(
    client=client,
    agent_id="crew-agent",
    terms_url="https://example.com/terms",
    terms_hash="a" * 64,
    emit_post_action=True,
)

def search(query: str) -> str:
    """Pretend to look something up."""
    return f"results for: {query}"

wrapped_search = wrap_tool(search, config=config, tool_name="search")
print(wrapped_search("openterms"))
```

**Expected output:**

```
results for: openterms
```

A pre-action and a post-action receipt are POSTed during the call.

### 5.5 — Verify a receipt against the public JWKS

```bash
pip install openterms cryptography
```

```python
import json, urllib.request
from openterms import verify_receipt

# 1. Fetch the public JWKS — no authentication needed.
with urllib.request.urlopen("{{STAGING_URL}}/.well-known/jwks.json") as resp:
    jwks = json.loads(resp.read())

# 2. Receipt obtained from your own logs, the GET /v1/receipts/{hash}
# endpoint, or a counterparty.
receipt = {  # … the full SignedReceipt object …
}

result = verify_receipt(receipt, jwks)
print(result.valid, result.error)
```

**Expected output (on a valid receipt):**

```
True None
```

**Expected output (on a tampered receipt):**

```
False HASH_MISMATCH
```

---

## Section 6 — Staging URL placeholder

The staging URL is not deployed at the time of this handoff. Polsia (or the operator) substitutes `{{STAGING_URL}}` with the real URL after the first Render deploy. The expected value is the form `https://openterms-trace-api.onrender.com` (or whatever Render assigns), with no trailing slash and no `/v1` suffix.

The placeholder `{{STAGING_URL_HOST}}` is the same URL with the `https://` scheme stripped (used only inside HTTP example `Host:` lines).

### Substitution checklist

Every occurrence of `{{STAGING_URL}}` in this handoff. Specifically:

| Section | Occurrence count |
| ------- | ---------------- |
| 2.6 API overview — base URL | 1 |
| 2.8 Receipts ingest — `Host:` line | 1 (`{{STAGING_URL_HOST}}`) |
| 2.12 JWKS — example `Host:` line | 1 (`{{STAGING_URL_HOST}}`) |
| 2.12 JWKS — body text | 1 |
| 2.14 Python SDK — replace `http://localhost:3000` | 1 |
| 2.15 TypeScript SDK — replace `http://localhost:3000` | 1 |
| 3.2 Staging environment — base URL, JWKS URL, health URL | 3 |
| 3.2 Staging environment — smoke-test snippet | 1 |
| 5.1 Python sample — `OPENTERMS_API_URL` | 1 |
| 5.2 TypeScript sample — `OPENTERMS_API_URL` | 1 |
| 5.3 LangChain sample — `OPENTERMS_API_URL` | 1 |
| 5.4 CrewAI sample — `OPENTERMS_API_URL` | 1 |
| 5.5 Verify sample — JWKS fetch URL | 1 |

Total: 14 occurrences of `{{STAGING_URL}}`, 2 of `{{STAGING_URL_HOST}}`. `sed -i 's|{{STAGING_URL}}|<actual-url>|g'` is safe.

---

## Section 7 — Calibration check

Re-reading the proposed updates against [`IMPLEMENTATION_STATUS.md`](../IMPLEMENTATION_STATUS.md), the package READMEs, the route handlers, and `openapi.yaml`:

### Calibration items to address before docs go live

1. **`IMPLEMENTATION_STATUS.md` is stale.** That file says Step 9 (documentation site) and Step 10 (deployment, hosted JWKS, auth, rate limiting, key management) are not done. Commit `01ebde5` ships Step 10. Before the docs go live, `IMPLEMENTATION_STATUS.md` must be refreshed against the current code or this handoff will be inconsistent with the linked source-of-truth document. **This handoff has been written against the actual code state at commit `01ebde5`, not against the stale status doc.**

2. **`docs/security/secrets-handling.md` is referenced in the prompt but does not exist in this commit.** I searched the tree; no such file exists. The handoff therefore creates a self-contained page at `/docs/operations/key-rotation` (Section 3.1) that captures the operator-driven rotation procedure. When the secrets-handling document ships in-repo, the docs page should be relinked to it.

3. **The OpenAPI contract describes a larger surface than the service implements.** The following are documented in `openapi.yaml` but **return 404 in the current deploy** and are flagged explicitly in the docs above as planned: `/v1/receipts/verify/{hash}`, `/v1/policies` (all methods), `/v1/policy/evaluate`, `/v1/keys`, `/v1/keys/rotate`, `/v1/workspace` (all methods), `/v1/webhooks/test`, OAuth2 flows. The docs must never present these as available. Every page that touches them above carries an explicit "not yet implemented" callout.

4. **Aggregation modes on `/v1/receipts` are partial.** The route handler implements the listed filters (`agent_id`, `action_type`, `decision`, `tool_id`, `from`, `to`, `limit`, `cursor`) but not `aggregate`, `q`, `triggered_rule`, `chain_id`, or `issuer`. The docs above mark these as planned.

5. **Async simulation is a stub.** `GET /v1/simulate/{job_id}` is wired but no async worker runs; corpora under 10,000 receipts (every supported corpus today) route through the synchronous path. The docs reflect this.

6. **`policy_version` on stored decisions is the hardcoded value.** Until policy CRUD ships, `policy_version` on every decision row is a single static identifier. The docs note this in 2.4.

7. **Webhook payloads are still not implemented.** The OpenAPI contract documents `POST /v1/webhooks/test`, but the underlying delivery machinery is not in the build. The docs explicitly mark webhooks as a planned capability and do not document a payload format yet (any payload doc would be premature).

8. **Regulatory context and SLA terms are out of scope for this session.** Both are flagged in the relevant docs locations as "pending product/legal input." The docs must not invent regulatory or contractual language.

### Eight documented content gaps — disposition

| Gap | Disposition |
| --- | ----------- |
| SDK signatures and install instructions | **Filled** — Sections 2.14–2.17 and 5.1–5.4. |
| API response schemas | **Filled** — Sections 2.8–2.12. |
| Simulation schema | **Filled** — Sections 2.5 and 2.11. |
| Key rotation procedure | **Filled** — Section 3.1. (Calibration item 2: relink when `docs/security/secrets-handling.md` ships.) |
| Webhook payloads | **Gap retained** — calibration item 7. |
| Regulatory context | **Gap retained** — pending product/legal input. |
| SLA terms | **Gap retained** — pending product input. |
| ORS test vectors | **Filled** — Section 3.3 (links to `tests/vectors/ors-v0.1/canonicalization.json`). |

No page in this handoff claims more than what is shipped at commit `01ebde5`.

---

## Section 8 — Rollout plan

### 8.1 — If applied manually before June 1

Order of application (highest impact first):

1. **2.1 Introduction.** Replaces the "coming soon" SDK callout with real package names. Highest visibility for new visitors.
2. **2.2 Quickstart + 5.1, 5.2.** First runnable code path for new users.
3. **2.7 Authentication.** Without this, every later sample fails with 401 and the docs look broken.
4. **2.6 API overview.** Sets reader expectations about what is and is not served.
5. **2.14, 2.15 SDK pages.** Drive package adoption.
6. **2.8–2.10 Endpoint reference (ingest, query, decisions).** Customers integrating beyond quickstart land here.
7. **2.12 JWKS** and **5.5 Verify sample.** Third-party verifiability is a public-trust feature; surface early.
8. **2.16, 2.17 Framework integrations.** Lower-traffic but high-conversion.
9. **2.5, 2.11 Simulation.** Lower urgency; specialized audience.
10. **3.1 Key rotation, 3.2 Staging, 3.3 Test vectors.** New pages — add after the in-place updates are stable.
11. **2.3, 2.4 Concept pages.** Lowest urgency; conceptual reference.
12. **Section 4 removals.** Last, so links into removed pages have already been rewritten by the earlier updates.

### 8.2 — If applied by Polsia after June 1

A structured prompt per page. Polsia consumes one prompt at a time, applies the diff, and runs the verification checklist (8.3) before moving to the next page.

```text
SYSTEM: You are updating the OpenTerms docs page at <PATH>.
INPUT:  The text block under "Exact text to apply" in Section 2.<N> of
        docs/HANDOFF_FOR_POLSIA.md.
TASK:   Replace the current page content with the input. Preserve the
        page's frontmatter (title, slug, sidebar order). Substitute every
        {{STAGING_URL}} occurrence with the deployed staging URL listed
        in Section 6. Substitute every {{STAGING_URL_HOST}} with the
        host-only form of that URL.
VERIFY: Run the corresponding checklist row from Section 8.3.
```

Repeat for each of the 17 pages plus the 3 new pages (Section 3) plus the removals (Section 4).

### 8.3 — Operator verification checklist

For every docs change, verify against the source-of-truth files:

- [ ] **2.1 Introduction.** Capability list matches the endpoint table in `apps/api/src/server.ts` route registrations.
- [ ] **2.2 Quickstart.** Code runs against `{{STAGING_URL}}` and returns a `canonical_hash` (manually exercised by the operator with a real `ot_test_…` key).
- [ ] **2.3 Receipts concept.** Three field groups match the `SignedReceipt` schema in `openapi.yaml`.
- [ ] **2.4 Policies and decisions.** Rule type enum matches the `Rule.type` enum in `openapi.yaml` and the policy engine in `packages/openterms-py/src/openterms/policy.py`.
- [ ] **2.5 Simulation concept.** Request and response shapes match `SimulationResult` in `openapi.yaml` and the handler at `apps/api/src/routes/simulate.ts`.
- [ ] **2.6 API overview.** "Implemented" table matches the route registrations in `apps/api/src/server.ts`.
- [ ] **2.7 Authentication.** Token prefixes and 401 error codes match `apps/api/src/auth/bearer.ts`.
- [ ] **2.8 Receipts ingest.** Error codes match `apps/api/src/routes/receipts.ts`.
- [ ] **2.9 Receipts query.** Filters match `apps/api/src/routes/receipts_query.ts`.
- [ ] **2.10 Decisions.** Filters match `apps/api/src/routes/decisions.ts`.
- [ ] **2.11 Simulate (API).** Sync threshold matches `SYNC_THRESHOLD` in `apps/api/src/routes/simulate.ts`.
- [ ] **2.12 JWKS.** Cache header matches `apps/api/src/routes/jwks.ts`.
- [ ] **2.13 Rate limits.** Default values match `apps/api/src/config.ts` (`rateLimitAuthIngest`, `rateLimitAuthQuery`, `rateLimitPublicPerIp`).
- [ ] **2.14 Python SDK.** Install command matches `packages/openterms-py/pyproject.toml` package name. Quickstart matches `packages/openterms-py/README.md`.
- [ ] **2.15 TypeScript SDK.** Install command matches `packages/openterms-ts/package.json` package name (`@openterms/sdk`).
- [ ] **2.16 LangChain.** Install + quickstart match `packages/langchain-openterms/README.md`.
- [ ] **2.17 CrewAI.** Install + quickstart match `packages/crewai-openterms/README.md`.
- [ ] **3.1 Key rotation.** Procedure matches `DEPLOYMENT.md` (`JWKS_SOURCE`, `ACTIVE_KEY_ID`, `PRIVATE_KEY_JWK`).
- [ ] **3.2 Staging.** Smoke checks match `scripts/smoke-staging.sh`.
- [ ] **3.3 Test vectors.** Link resolves and the file at the link is the same one that `apps/api/tests/canonical.test.ts` and `packages/openterms-py/tests/test_canonical.py` consume.
- [ ] **All pages.** No mention of `POST /v1/policies`, `POST /v1/keys/rotate`, `GET /v1/workspace`, `POST /v1/webhooks/test`, `GET /v1/receipts/verify/{hash}`, or OAuth2 as available. Each is either omitted or carried under a "planned" callout.
- [ ] **All pages.** Every `{{STAGING_URL}}` and `{{STAGING_URL_HOST}}` has been substituted.
- [ ] **[`IMPLEMENTATION_STATUS.md`](../IMPLEMENTATION_STATUS.md) refreshed.** Before the docs are made public, the source-of-truth status document must be updated to reflect Step 10 shipped (calibration item 1).

---

*End of handoff.*
