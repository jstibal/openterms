You are revising the OpenAPI contract for OpenTerms Agent Action Observability.

Inputs:
- current openapi.yaml
- OpenTerms Agent Action Observability Build Brief
- ORS spec repo: https://github.com/jstibal/ors-spec
- openterms-mcp reference repo: https://github.com/jstibal/openterms-mcp

Task:
Revise openapi.yaml so it matches the governing build brief and verified external sources.

Do NOT implement backend code.
Do NOT create SDKs.
Do NOT modify database schema.
Do NOT build UI.
Do NOT guess if a source of truth is unclear.

Required workflow:
1. Read openapi.yaml.
2. Read the build brief.
3. Check the ORS spec repo for:
   - current ORS version
   - license
   - canonicalization rules
   - test vectors
4. Check openterms-mcp only for receipt/signature semantics if needed.
5. Apply revisions only where supported by the brief or verified sources.
6. For anything unclear, produce an "Unresolved Decisions" section instead of guessing.

Required contract revisions:
- Rename product from "OpenTerms Trace API" to "OpenTerms Agent Action Observability API."
- Change license only if verified against the governing brief and source repos.
- Make ORS version handling explicit.
- Add POST /v1/webhooks/test if consistent with the stable API surface.
- Align SignedReceipt schema with the brief, including receipt_id, created_at, and amount_charged if still required.
- Clarify whether receipt_id, created_at, and amount_charged are ORS body fields or application envelope fields.
- Add issuer/key discovery fields needed for multi-issuer verification, but only if justified by the brief or ORS/MCP references.
- Clarify JWKS hosting and routing assumptions.
- Normalize policy rule type names to match the build brief, but flag any mismatch between the brief, existing OpenAPI, and external references.
- Add chain_id and issuer filters where required.
- Add count_by_day aggregation.
- Clarify auth distinctions:
  SDK API key, dashboard OAuth bearer, admin endpoints, public endpoints.
- Strengthen append-only receipt semantics.
- Preserve public CORS-open JWKS and public verification endpoint.
- Preserve deterministic policy semantics.

Operational rules:
- Before modifying openapi.yaml, copy it to openapi.yaml.bak. The original draft remains on disk after the revision so it can be diffed against the revision.
- After producing the revised openapi.yaml, run an OpenAPI 3.1 linter (for example, npx @redocly/cli lint openapi.yaml, or @stoplight/spectral-cli, or any equivalent OpenAPI 3.1 linter). Include the lint output in your response. If the file does not parse cleanly, fix the parse errors before reporting completion.

Acceptance:
- openapi.yaml parses successfully.
- All stable endpoints from Section 9 of the brief exist.
- ORS version target is explicit.
- License is explicit and source-supported.
- Rule type names are either aligned or unresolved discrepancies are documented.
- No backend code changes.
- No SDK code changes.
- No UI changes.

Output:
1. Revised openapi.yaml.
2. Summary of material changes.
3. Unresolved Decisions section listing any issue that requires human choice.
4. Exact sources used for ORS version, license, and signing/canonicalization assumptions.
