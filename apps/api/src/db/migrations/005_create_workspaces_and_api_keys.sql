-- Workspaces and bearer-token API keys.
--
-- workspaces:   one row per tenant. A future control plane will manage
--               creation; for staging we seed via scripts/seed-test-workspace.
-- api_keys:     bearer tokens, stored as HMAC-SHA256(token, API_KEY_SALT).
--               The plaintext token is shown to the user exactly once at
--               creation and never persisted. Lookups parse the prefix
--               (e.g. "ot_live_") to scope the search before hashing.

CREATE TABLE IF NOT EXISTS workspaces (
  id            UUID PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY,
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key_prefix    TEXT NOT NULL,
  key_hash      BYTEA NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NULL,
  revoked_at    TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uniq ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS api_keys_workspace_idx ON api_keys (workspace_id);
