#!/usr/bin/env bash
# Post-deploy smoke test against the staging service.
#
# Exits non-zero if any of:
#   - /healthz does not return ok
#   - /.well-known/jwks.json does not return a JWK Set with >=1 key
#   - an unauthenticated request to /v1/receipts returns anything other
#     than 401
#   - an authenticated request to /v1/receipts returns non-2xx
#
# Required env:
#   STAGING_URL      e.g. https://openterms-trace-api.onrender.com
#   TEST_API_KEY     bearer token seeded by scripts/seed-test-workspace
#
# This script does NOT post a receipt — that requires a signed payload
# from the SDK. The receipt round-trip is covered by the integration
# test under apps/api/tests/ when pointed at the staging URL.

set -euo pipefail

: "${STAGING_URL:?STAGING_URL is required}"
: "${TEST_API_KEY:?TEST_API_KEY is required}"

BASE="${STAGING_URL%/}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

step() { printf '\n==> %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

step "GET $BASE/healthz"
code=$(curl -sS -o "$TMP/healthz" -w '%{http_code}' "$BASE/healthz")
[[ "$code" == "200" ]] || fail "healthz returned $code"
grep -q '"ok":true' "$TMP/healthz" || fail "healthz body did not contain ok:true"

step "GET $BASE/.well-known/jwks.json"
code=$(curl -sS -o "$TMP/jwks" -w '%{http_code}' "$BASE/.well-known/jwks.json")
[[ "$code" == "200" ]] || fail "jwks returned $code"
grep -q '"keys"' "$TMP/jwks" || fail "jwks missing 'keys' array"

step "Unauthenticated GET $BASE/v1/receipts (expect 401)"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/v1/receipts")
[[ "$code" == "401" ]] || fail "unauth /v1/receipts returned $code, expected 401"

step "Authenticated GET $BASE/v1/receipts"
code=$(curl -sS -o "$TMP/receipts" -w '%{http_code}' \
  -H "Authorization: Bearer $TEST_API_KEY" "$BASE/v1/receipts?limit=1")
[[ "$code" == "200" ]] || fail "/v1/receipts returned $code with bearer"

printf '\nAll smoke checks passed against %s\n' "$BASE"
