# OpenTerms Agent Action Observability — Build Brief

## 1. Mission

You are building the backend services, SDK packages, and persistence layer for a new product called OpenTerms Agent Action Observability. The product gives enterprises a verifiable audit trail of every action their autonomous AI agents take. Each agent action produces a cryptographically signed receipt conforming to the Open Receipt Specification v0.1. Receipts are ingested, validated, and stored in an append-only log that customers query for audit, compliance, simulation, and policy iteration.

You are working in a conventional development environment (terminal, Cursor or VS Code, GitHub, Render, Neon Postgres). A separate dashboard surface handles the dashboard UI, the marketing site, and the user-facing onboarding flows. You do not touch that surface. It consumes your API and renders the human interface. Your responsibility ends at the public API surface.

## 2. What This Product Is

A standardized, vendor-neutral system of record for autonomous agent actions, organized around three properties:

- Every action produces an ORS-conformant signed receipt
- Every policy decision is deterministic and explainable
- Every receipt is verifiable by any third party using the published JWKS

The category is observability for autonomous agent actions. The closest analogues are distributed tracing for microservices and security information and event management for enterprise security. The substrate that differentiates the product is the ORS receipt format.

The product is NOT a runtime gateway, NOT a permissions registry, NOT a model-judged guardrail, and NOT a payments primitive. Anyone, anywhere can verify a receipt without contacting your service beyond the JWKS endpoint.

## 3. Hybrid Architecture

Two execution surfaces, joined by a public REST API.

**Your scope (conventional environment):**
- Ingest API (receives signed receipts, verifies, deduplicates, persists)
- Policy engine (deterministic rule evaluation, returns allow/deny/escalate)
- Query API (filtered queries and aggregations over the decision log)
- Simulation backend (replays candidate rules against historical receipts)
- Key management and JWKS distribution (Ed25519 keys, public key publication)
- SDK packages (openterms-py, langchain-openterms, crewai-openterms)
- Documentation site (markdown source in this repo, deploys to static hosting)

**Dashboard surface scope (not yours):**
- Dashboard (React SPA, six tabs, consumes your public API)
- Marketing site (landing page, pricing)
- User onboarding flows (request access, workspace creation UI)

The dashboard surface talks to your service via HTTPS API calls with API keys for SDK consumers and OAuth for dashboard users. It never accesses your database directly. It never sees private key material.

## 4. Hard Correctness Constraints

These are non-negotiable. CI must fail and deployment must block if any of these fail.

**ORS canonicalization vectors.** Twelve test vectors published in ORS-v0.1 Appendix B. Every receipt your SDK and your ingest service produce must canonicalize byte-exact to the expected SHA-256 hashes. Fetch the spec from `https://github.com/jstibal/ors-spec/blob/main/ORS-v0.1.md` and the vectors from the same repository. Validate against these vectors on every CI run.

**Ed25519 domain separation.** Signatures are over the 40-byte concatenation of `ORSv0.1\x00` (8 bytes) and the raw 32-byte SHA-256 hash. NOT the hex-encoded hash. NOT just the hash. Use `@noble/ed25519` for TypeScript/JavaScript or the `cryptography` Python library for Python. Verify against the openterms-mcp reference implementation at `https://github.com/jstibal/openterms-mcp`.

**Policy engine determinism.** Same (policy, receipt) input must produce the same decision every time. No LLM in the policy evaluation path. No regular expressions outside the constrained pattern language defined in the rule schema. 100 percent statement coverage in tests. 50 fixture pairs of (policy, receipt, expected decision) must pass on every CI run.

**Append-only receipt log.** Receipts are never modified after persistence. Receipts that fail signature verification MUST NOT be written to the receipts table. Failed verifications log to a separate error stream for diagnosis.

**Private key isolation.** Private signing keys live only in environment variables on the Render service. Never in source control. Never in logs. Never in API responses. The JWKS endpoint serves only public key material.

## 5. Reuse Sources

Three external sources to fetch and adapt:

**ORS specification.**
- Repository: `https://github.com/jstibal/ors-spec`
- File: `ORS-v0.1.md` (the full normative spec)
- File: `verify.py` (reference Python verifier — use this in CI as the third-party verification path)
- Folder: `examples/` (nine annotated receipts demonstrating all features)
- License: Apache 2.0

**OpenTerms MCP reference implementation.**
- Repository: `https://github.com/jstibal/openterms-mcp`
- Use as the reference for receipt issuance and verification semantics. Your ingest service accepts receipts from this implementation and from your own SDK; both must verify identically.
- License: Apache 2.0

**Legacy codebase (provided to you separately).**
- Contains a working policy engine at `server/core/policy.ts` — port and extend with three additional rule types (`tool_id_allowlist`, `args_pattern_match`, `post_state_assertion`)
- Contains receipt validation patterns at `server/core/receipt.ts` — port, adapt field set to ORS payload schema
- Contains decision log schema in `drizzle/schema.ts` (`policyDecisionLog` table) — port, extend with `receipt_id`, `ors_commitments`, full-text index on reasons
- Contains receipts persistence schema in `drizzle/schema.ts` (`receipts` table) — adapt fields to ORS payload structure
- Contains idempotency keys schema (`idempotencyKeys` table) — adopt unchanged
- DO NOT port: USDC ledger, wallet authentication, deposits, provider verification flow. Discard.

## 6. Tech Stack

- Node.js (LTS, version 20 or higher) for the API service and SDKs
- TypeScript everywhere
- Express or Fastify for the HTTP layer
- Postgres on Neon (managed)
- Drizzle ORM for the database layer (legacy codebase uses Drizzle; continue this pattern)
- `@noble/ed25519` for signing and verification
- `@noble/hashes/sha2` for SHA-256
- `canonicalize` npm package for RFC 8785 canonicalization, with custom null-stripping wrapper to match ORS rules
- Vitest or Jest for unit tests
- GitHub Actions for CI
- Render for hosting
- Python 3.10+ for the openterms-py SDK; use the `cryptography` library

## 7. Repository Structure

Single monorepo. The layout below is normative — follow it.

```
openterms-trace/
├── apps/
│   └── api/                    # Express service: ingest, query, simulate, JWKS
│       ├── src/
│       │   ├── routes/
│       │   ├── core/           # canonical.ts, signing.ts, receipt.ts, policy.ts
│       │   ├── db/             # Drizzle schema and queries
│       │   └── lib/
│       ├── tests/
│       │   ├── vectors/        # ORS canonicalization test vectors
│       │   └── fixtures/       # Policy engine (policy, receipt, decision) tuples
│       └── package.json
├── packages/
│   ├── openterms-py/           # Python SDK
│   ├── openterms-ts/           # TypeScript SDK
│   ├── langchain-openterms/    # LangChain adapter
│   └── crewai-openterms/       # CrewAI adapter
├── docs/                       # Markdown documentation, deploys to static hosting
│   ├── agents/
│   ├── developers/
│   ├── platform/
│   ├── compliance/
│   └── security/
├── migrations/                 # Drizzle migrations, one file per schema change
├── scripts/
│   ├── verify-release.sh       # Release gate script
│   └── canonical-vectors.ts    # Validates ORS test vectors on every CI run
├── .github/workflows/
│   ├── ci.yml                  # Lint, type check, test, vectors, fixtures
│   ├── deploy.yml              # Render deploy on main, gated by verify-release
│   └── sdk-publish.yml         # PyPI and npm publish on tags
├── package.json
├── tsconfig.json
├── README.md
└── LICENSE                     # Apache 2.0
```

## 8. Initial Build Sequence

Build in the order below. Each step has acceptance criteria. Do not move to the next step until the criteria pass.

**Step 1: Repository scaffolding.**
Create the structure above. Initialize package.json files. Add LICENSE (Apache 2.0). Add a README that names the product, the architecture, and links to the ORS spec. Configure GitHub Actions to run lint + type check on push.

Acceptance: `npm install` succeeds at the root. `npm run typecheck` succeeds. CI passes on a fresh commit.

**Step 2: Canonicalization and signing core.**
Port the canonicalization logic from the legacy `server/core/canonical.ts`. Add the null-stripping rule from the ORS spec (recursively remove keys whose values are null). Implement the ORSv0.1 domain-separation prefix in the signing path. Write a CI script that validates against the twelve ORS canonicalization test vectors.

Acceptance: All twelve vectors produce the expected SHA-256 hashes. CI fails on any vector mismatch.

**Step 3: Receipt validation and ingest pipeline.**
Build the POST /v1/receipts/ingest endpoint. The endpoint accepts a signed ORS receipt, validates against the JSON schema (workspace_id, agent_id, action_type, terms_url, terms_hash, timestamp, pricing_version, plus signed envelope fields receipt_id, amount_charged, created_at), verifies the Ed25519 signature against the issuer JWKS, deduplicates by canonical_hash unique index, and persists to the receipts table. Returns structured error codes (VALIDATION_ERROR, SIGNATURE_INVALID, UNKNOWN_ISSUER, DUPLICATE). Honors Idempotency-Key header.

Acceptance: A receipt produced by the openterms-mcp reference implementation ingests successfully. A receipt with a tampered field fails with SIGNATURE_INVALID. Duplicate ingest returns the stored receipt. Throughput sustains 500 receipts per second on staging hardware.

**Step 4: Policy engine.**
Port the engine from the legacy `server/core/policy.ts`. Existing rule types: max_amount, daily_limit, action_type_allowlist, action_type_denylist, url_prefix_allowlist, url_prefix_denylist, escalation_threshold. Add three: tool_id_allowlist, args_pattern_match, post_state_assertion. The args_pattern_match rule uses a constrained pattern language defined in the rule schema; pattern evaluation MUST be bounded in time (under 5 ms per receipt at p99) and memory. Build POST /v1/policy/evaluate that accepts a policy version and a receipt payload, returns a decision with structured reasons and triggered_rules.

Acceptance: A fixture of 50 (policy, receipt, expected decision) tuples passes. 100 percent statement coverage. Pattern evaluation timeouts return decision: deny with reason TIMEOUT.

**Step 5: Decision log query API.**
Build GET /v1/receipts and GET /v1/decisions with filters (agent_id, action_type, decision, tool_id, time range, chain_id, triggered_rule, issuer), aggregations (count by decision, by triggered_rule, by tool_id, by agent_id, by hour or day), and cursor-based pagination on (timestamp, receipt_id). Add a full-text index on the reasons field for a `q` parameter. Scope all queries to the authenticated workspace.

Acceptance: Query latency at p99 under 250 ms against a corpus of 100,000 receipts. No cross-workspace data leakage. Pagination stable under concurrent inserts.

**Step 6: Key management and JWKS.**
Generate Ed25519 key pairs, store private keys encrypted at rest using a symmetric key from an environment variable, publish public keys at /.well-known/jwks.json conforming to RFC 7517 (kty=OKP, crv=Ed25519). Support rotation: generate new active key, mark prior key inactive but keep in the JWKS indefinitely. Document the DR runbook covering key compromise, region failure, and signing service downtime.

Acceptance: JWKS endpoint returns valid JSON Web Key Set with Cache-Control max-age 86400. The ORS Python verifier validates receipts signed by both pre-rotation and post-rotation keys. DR runbook delivered as docs/security/key-management.md.

**Step 7: Simulation backend.**
Build POST /v1/simulate. Accepts a candidate rule set and a time range. Replays the rule set against every receipt in the range, returns counterfactual decision counts (by decision, by triggered_rule, by tool), a diff against actual decisions, and a deterministic sample of up to 100 receipts where the counterfactual differs from the actual decision. Read-only on the receipt corpus. Simulation MUST NOT affect any live policy evaluation.

Acceptance: Simulation against 10,000 receipts completes within 30 seconds at p95. Counterfactual decisions match the policy engine's outputs for the same (policy, receipt) pairs. Repeated simulations against the same input produce identical samples.

**Step 8: SDK emit_receipt.**
Implement emit_receipt(action_type, terms_url, terms_hash, action_context) in openterms-py for pre-action receipts. Implement emit_post_action_receipt(receipt_id, post_state_hash) for post-action receipts. SDK constructs ORS-conformant payloads, signs with the workspace key, transmits to the ingest endpoint, returns the canonical hash. Replicate the pattern in openterms-ts. Add LangChain and CrewAI adapter classes that wrap tool calls and emit receipts automatically. Every SDK validates against the same twelve canonicalization vectors as the ingest service.

Acceptance: Receipts emitted by each SDK verify successfully through the ORS Python verifier. End-to-end test: SDK emits, ingest accepts, query API returns. Twelve canonicalization vectors pass on every CI run for every SDK package.

**Step 9: Documentation site.**
Author markdown in docs/ for the five tracks (agents, developers, platform, compliance, security). Each track is independently navigable. Code samples in each track are runnable against staging and validated in CI. Deploy to a static hosting target (Cloudflare Pages or Vercel) on every push to main.

Acceptance: Each track returns 200 at its canonical URL. Code samples in each track pass an automated runnability check against staging.

**Step 10: Release gate.**
Make `scripts/verify-release.sh` the gate for production deployment. The script verifies, at minimum: all twelve ORS canonicalization vectors pass, all 50 policy fixtures pass, an end-to-end integration test (SDK emits → ingest accepts → query returns → Python verifier confirms) passes, the migrations directory contains all referenced tables, and rate limiter middleware is active on all expected endpoints. CI fails if any check fails. Render deployment is blocked until verify-release exits 0.

Acceptance: CI runs verify-release on every push to main. Production deployment fails if verify-release fails. The script outputs a structured report. A run history is captured for the prior 30 deployments.

## 9. API Contract (Stable Surface for the Dashboard)

The dashboard surface depends on the public API. Once shipped, breaking changes require a versioned new endpoint, not a modification of the existing one. The stable surface:

```
POST   /v1/receipts/ingest             # SDK emits receipts here
GET    /v1/receipts                    # Filtered list
GET    /v1/receipts/{hash}             # Single receipt
GET    /v1/receipts/{hash}/verify      # Public verification, no auth required
GET    /v1/decisions                   # Filtered decision log
POST   /v1/policy/evaluate             # Stateless evaluation
GET    /v1/policies                    # List rule sets
POST   /v1/policies                    # Create rule set version
PATCH  /v1/policies/{id}/activate      # Activate version
POST   /v1/simulate                    # Replay candidate rules
GET    /v1/keys                        # List signing keys
POST   /v1/keys/rotate                 # Generate new active key
GET    /.well-known/jwks.json          # Public key distribution, edge-cacheable
GET    /v1/workspace                   # Workspace metadata
PATCH  /v1/workspace                   # Update workspace settings
POST   /v1/webhooks/test               # Send a sample delivery
```

All endpoints except `/v1/receipts/{hash}/verify` and `/.well-known/jwks.json` require authentication via Bearer API key. The verify endpoint and the JWKS endpoint are public and CORS-open so any third party can verify receipts independently.

## 10. Anti-Patterns (Things You Must Not Do)

- Do not implement Ed25519 from primitives. Use audited libraries.
- Do not implement canonicalization from scratch beyond the documented RFC 8785 plus null-stripping wrapper. Validate against the test vectors before any other testing.
- Do not introduce model-judged decisions in the policy evaluation path.
- Do not introduce wallet, USDC, or on-chain settlement primitives. The legacy codebase contains these; do not port them.
- Do not introduce provider-side verification flows in the initial release. Defers to a later workstream.
- Do not store private keys in source control, in logs, or in any API response. Render environment variables only.
- Do not build a dashboard or any UI in this repository. A separate dashboard surface owns UI surfaces.
- Do not weaken the release gate to ship faster. The release gate is the product's correctness claim.
- Do not bypass CI for any reason. The release gate is the only path to production.

## 11. Definition of Done for Initial Release

All ten steps in section 8 pass acceptance. The release gate fires on every push to main. The deployed staging service:

- Accepts receipts from the openterms-mcp reference implementation and from the bundled SDK
- Verifies receipts through the ORS Python verifier from the spec repository
- Returns query results under 250 ms p99 against 100,000 receipts
- Sustains 500 receipts per second on the ingest endpoint
- Completes simulations against 10,000 receipts within 30 seconds at p95
- Publishes a JWKS with at least one active Ed25519 key
- Documents the DR runbook for key management

The dashboard team consumes the public API contract from section 9 to build the dashboard. Coordinate on contract changes; do not break the contract once shipped.

## 12. Communication Protocol

You report progress against the ten steps in section 8 in order. Each step's acceptance criteria are binary: passed or not passed. You do not move to step N+1 until step N passes.

If you hit a blocker that requires a decision outside this brief, surface it explicitly with the form: "Blocker on step X. The decision required is [description]. The options are [A, B, C]. The recommendation is [option] because [reason]." Do not invent answers to scope questions not addressed in this brief.

## 13. Reference Links

- ORS spec: https://github.com/jstibal/ors-spec
- ORS spec text: https://github.com/jstibal/ors-spec/blob/main/ORS-v0.1.md
- Python verifier: https://github.com/jstibal/ors-spec/blob/main/verify.py
- ORS examples: https://github.com/jstibal/ors-spec/tree/main/examples
- OpenTerms MCP reference: https://github.com/jstibal/openterms-mcp
- Current OpenTerms registry: https://openterms.com
- RFC 8785 (JSON Canonicalization): https://www.rfc-editor.org/rfc/rfc8785
- RFC 8032 (Ed25519): https://www.rfc-editor.org/rfc/rfc8032
- RFC 7517 (JWKS): https://www.rfc-editor.org/rfc/rfc7517

## 14. License

Apache 2.0 for the API service, SDKs, and documentation. Match the license of the ORS spec and the openterms-mcp reference implementation to ensure compatible derivative works.
