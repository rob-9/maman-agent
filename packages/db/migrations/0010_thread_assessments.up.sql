-- 0010: what the agent concluded about a thread.
--
-- The detector finds candidates by arithmetic and rewrites its pending rows
-- on every sync. The agent's judgment costs a model call and must survive
-- that rewrite, so it lives beside the obligation, keyed by thread, and is
-- reused until the thread moves on (assessed_last_message_at). The arithmetic
-- reason stays on the obligation untouched: with the agent switched off the
-- list is exactly what it was before this table existed.
CREATE TABLE thread_assessments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  thread_id uuid NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  -- The thread state this judgment describes. A newer message invalidates it.
  assessed_last_message_at timestamptz NOT NULL,
  -- The model's answer, schema-checked before it is stored. Never a body.
  assessment jsonb NOT NULL,
  model_alias text NOT NULL,
  assessed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id)
);

ALTER TABLE thread_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON thread_assessments
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
