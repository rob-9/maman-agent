-- 0019: runs of an accepted routine. Phase 3, step 4.
--
-- One row per time a routine's trigger happened after the person accepted
-- it. In shadow mode the row holds what the routine would have done and
-- what the person then did, compared once the episode closed. In
-- supervised mode it holds what the routine produced: a draft, a proposal,
-- each of which still waits for the person through its own ladder. Per
-- person, keyed by the trigger event so a sweep never runs one twice.
CREATE TABLE routine_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  routine_id uuid NOT NULL REFERENCES routine_candidates (id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  agent_version_id uuid NOT NULL,
  trigger_event_id uuid NOT NULL,
  triggered_at timestamptz NOT NULL,
  -- The case (a hash) the trigger was about, so the person's later events on it can be found.
  case_ref text,
  mode text NOT NULL CHECK (mode IN ('shadow', 'supervised')),
  status text NOT NULL CHECK (status IN ('watching', 'completed', 'skipped', 'failed')),
  -- Hashes and capability ids; never a value.
  proposed jsonb NOT NULL DEFAULT '[]'::jsonb,
  actual jsonb,
  comparison jsonb,
  outputs jsonb,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (owner_user_id, routine_id, trigger_event_id)
);

CREATE INDEX idx_routine_runs_owner
  ON routine_runs (organization_id, owner_user_id, routine_id, triggered_at DESC);

ALTER TABLE routine_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE routine_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON routine_runs
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
