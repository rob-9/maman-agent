-- 0017: the event stream. Phase 3 of the plan, step 1.
--
-- One row per thing the person did, in the canonical WorkflowEvent shape
-- from @maman/contracts: source, app, event type, roles, categories, hashed
-- identifiers, counts, time. Never a body, never a value, never a raw
-- record id: the contract is strict and refuses those fields, and the
-- repository checks again before writing. This is what discovery runs on,
-- so it is per person like everything they own.
--
-- Derived, not observed: every synced fact and every click in the product
-- is turned into an event by the sweep, idempotently. The dedupe key names
-- the fact (message, meeting, action, decision, sentence) so a backfill and
-- a re-run write nothing twice.
CREATE TABLE workflow_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  occurred_at timestamptz NOT NULL,
  source text NOT NULL,
  event_type text NOT NULL,
  dedupe_key text NOT NULL,
  -- The whole event, validated against the contract before it got here.
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, dedupe_key)
);

CREATE INDEX idx_workflow_events_owner_time
  ON workflow_events (organization_id, owner_user_id, occurred_at);

ALTER TABLE workflow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_events FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON workflow_events
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
