-- 0016: the agent acts on a system of record. Phase 3 begins.
--
-- An action is a proposed write with its exact diff, the evidence it rests
-- on, and everything that happened to it afterwards: approved (bound to the
-- diff's hash), applied (once, by idempotency marker), verified (by an
-- independent read of the record), failed, stale, or reverted. This row IS
-- the receipt. It is per person, like everything they own, and append-only
-- in spirit: status moves forward and the history stays.
CREATE TABLE actions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  -- What kind of write. The capability id, e.g. salesforce.log_activity.
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'approved', 'applied', 'verified', 'failed', 'stale', 'declined', 'reverted')),
  -- What it is about. Ids only.
  thread_id uuid REFERENCES threads (id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts (id) ON DELETE SET NULL,
  message_external_id text,
  -- The exact write, in plain structure, and its hash. Approval binds to the hash.
  diff jsonb NOT NULL,
  diff_sha256 text NOT NULL,
  -- The shape of the write (kind + field names), so a promotion covers this
  -- shape and no other.
  shape_sha256 text NOT NULL,
  -- Why: what was witnessed. Ids and dates, never bodies.
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Exactly once: this marker travels with the write and is searched for
  -- before any retry.
  idempotency_key text NOT NULL UNIQUE,
  -- Who approved: 'user' (a click) or 'promotion' (a standing rule the person made).
  approved_by text CHECK (approved_by IN ('user', 'promotion')),
  approved_at timestamptz,
  applied_at timestamptz,
  -- The record the provider created, and what the independent read showed.
  external_id text,
  verification jsonb,
  verified_at timestamptz,
  -- How to put it back, and whether we did.
  revert jsonb,
  reverted_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_actions_owner_status
  ON actions (organization_id, owner_user_id, status, created_at DESC);

ALTER TABLE actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE actions FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON actions
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
