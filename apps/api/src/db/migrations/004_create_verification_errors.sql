-- Verification errors — append-only log of receipts that FAILED verification.
--
-- Receipts that fail verification (bad signature, hash mismatch, unknown
-- issuer, malformed payload) never make it into the receipts table, so
-- without a separate stream they only exist in rotating application logs.
-- That makes after-the-fact audit ("how many bad signatures last week from
-- agent X?") impossible. This table is a queryable failure stream.
--
-- Append-only by trigger, same pattern as the receipts table.

CREATE TABLE IF NOT EXISTS verification_errors (
  id              BIGSERIAL   PRIMARY KEY,
  workspace_id    UUID        NOT NULL,
  -- canonical_hash *as claimed by the client* — may be wrong on HASH_MISMATCH.
  -- Nullable because malformed payloads may not carry one at all.
  claimed_hash    CHAR(64),
  error_code      TEXT        NOT NULL,
  -- Optional structured details (e.g. expected vs computed hash for
  -- HASH_MISMATCH; the key_id we looked up for UNKNOWN_ISSUER).
  details         JSONB,
  -- Bounded snippet of the receipt body for debugging. Capped at 4 KiB at
  -- write time so a malicious large payload cannot blow up the table.
  receipt_snippet TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_verr_workspace_time
  ON verification_errors (workspace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_verr_error_code
  ON verification_errors (workspace_id, error_code, occurred_at DESC);

CREATE OR REPLACE FUNCTION verification_errors_reject_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'verification_errors table is append-only; % rejected', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS verr_no_update ON verification_errors;
CREATE TRIGGER verr_no_update BEFORE UPDATE ON verification_errors
  FOR EACH ROW EXECUTE FUNCTION verification_errors_reject_mutation();

DROP TRIGGER IF EXISTS verr_no_delete ON verification_errors;
CREATE TRIGGER verr_no_delete BEFORE DELETE ON verification_errors
  FOR EACH ROW EXECUTE FUNCTION verification_errors_reject_mutation();
