-- Decisions table — append-only log of policy engine outcomes, keyed 1:1 to
-- the receipt the decision was made for. One decision per receipt for v1;
-- re-evaluation against a new policy version is future work and would land in
-- a separate decision_history table rather than mutating this one.
--
-- Append-only is enforced both at the API layer (only INSERTs ever issued)
-- and by row-level UPDATE/DELETE triggers so an out-of-band psql session
-- cannot mutate stored decisions. TRUNCATE remains available for test setup.

CREATE TABLE IF NOT EXISTS decisions (
  -- 1:1 with receipts.canonical_hash. PK doubles as the FK target.
  receipt_hash      CHAR(64)    PRIMARY KEY REFERENCES receipts(canonical_hash),
  workspace_id      UUID        NOT NULL,
  decision          TEXT        NOT NULL CHECK (decision IN ('allow', 'deny', 'escalate')),

  -- Rule IDs that fired during evaluation, in evaluation order.
  triggered_rules   JSONB       NOT NULL,
  -- Structured reason strings, one per fired rule plus an optional TIMEOUT or
  -- ENGINE_ERROR sentinel when the engine fails to complete normally.
  reasons           JSONB       NOT NULL,

  policy_version    TEXT        NOT NULL,
  evaluated_at      TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decisions_workspace_evaluated
  ON decisions (workspace_id, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_decisions_decision
  ON decisions (workspace_id, decision);

-- GIN index supports the future GET /decisions?rule=<id> query path.
CREATE INDEX IF NOT EXISTS idx_decisions_triggered_rules
  ON decisions USING GIN (triggered_rules);

CREATE OR REPLACE FUNCTION decisions_reject_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'decisions table is append-only; % rejected', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decisions_no_update ON decisions;
CREATE TRIGGER decisions_no_update BEFORE UPDATE ON decisions
  FOR EACH ROW EXECUTE FUNCTION decisions_reject_mutation();

DROP TRIGGER IF EXISTS decisions_no_delete ON decisions;
CREATE TRIGGER decisions_no_delete BEFORE DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION decisions_reject_mutation();
