-- Idempotency keys — per-workspace mapping from client-supplied key to the
-- canonical_hash of the receipt that was ingested under it. Used to detect
-- replays (same payload → return stored response) and conflicts (same key,
-- different payload → 409 IDEMPOTENCY_KEY_CONFLICT). Only recorded on
-- successful (2xx) ingest; failed verifications are never written here so
-- clients can retry with corrected data.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  workspace_id        UUID        NOT NULL,
  idempotency_key     TEXT        NOT NULL,
  canonical_hash      CHAR(64)    NOT NULL REFERENCES receipts(canonical_hash),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, idempotency_key)
);
