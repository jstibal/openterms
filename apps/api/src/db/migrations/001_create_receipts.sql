-- Receipts table — append-only log of verified ORS receipts.
--
-- Append-only is enforced two ways:
--   1. The API layer only ever inserts.
--   2. Triggers on UPDATE/DELETE raise so even an out-of-band psql session
--      cannot mutate stored rows. Use TRUNCATE (DDL, not row-level) to clear
--      the table in test setup. The `raw_receipt` JSONB column preserves the
--      exact on-wire form so GET /receipts/{hash} can echo the original bytes.

CREATE TABLE IF NOT EXISTS receipts (
  -- Section 3c signature metadata (NOT signed, but stored alongside payload).
  canonical_hash      CHAR(64)    PRIMARY KEY,
  signature           TEXT        NOT NULL,
  key_id              TEXT        NOT NULL,

  -- Section 3a required signed payload.
  workspace_id        UUID        NOT NULL,
  agent_id            TEXT        NOT NULL,
  action_type         TEXT        NOT NULL,
  terms_url           TEXT        NOT NULL,
  terms_hash          CHAR(64)    NOT NULL,
  ts                  TIMESTAMPTZ NOT NULL,
  pricing_version     TEXT        NOT NULL,

  -- Section 3b signed envelope.
  receipt_id          UUID        NOT NULL,
  amount_charged      BIGINT      NOT NULL,
  receipt_created_at  TIMESTAMPTZ NOT NULL,

  -- Section 3a optional signed payload.
  action_context      JSONB,
  ors_version         TEXT,
  issuer              TEXT,
  provider            JSONB,
  decision            JSONB,
  request_binding     JSONB,

  -- v0.2 optional signed payload.
  terms_type          TEXT,
  terms_service       TEXT,
  terms_version       TEXT,

  -- Server-side.
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_receipt         JSONB       NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipts_workspace_ts
  ON receipts (workspace_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_receipts_workspace_agent_action
  ON receipts (workspace_id, agent_id, action_type);

CREATE INDEX IF NOT EXISTS idx_receipts_chain_id
  ON receipts ((action_context -> 'ors' -> 'chain' ->> 'chain_id'))
  WHERE action_context -> 'ors' -> 'chain' ->> 'chain_id' IS NOT NULL;

CREATE OR REPLACE FUNCTION receipts_reject_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'receipts table is append-only; % rejected', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS receipts_no_update ON receipts;
CREATE TRIGGER receipts_no_update BEFORE UPDATE ON receipts
  FOR EACH ROW EXECUTE FUNCTION receipts_reject_mutation();

DROP TRIGGER IF EXISTS receipts_no_delete ON receipts;
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION receipts_reject_mutation();
