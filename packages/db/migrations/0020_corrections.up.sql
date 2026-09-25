-- 0020: corrections. What the agent proposed against what the person did.
--
-- One row per pair, whatever the output was: a draft against the message
-- sent, a proposed field against the value the person chose or the proposal
-- they declined, a routine's expected steps against the steps taken. The
-- row holds the kind, a reference to the thing, the person it concerned, a
-- short list of signals (plain tokens like "shorter" or "signoff:Best, Alex")
-- and a summary of numbers and forms. Never the text itself: the draft and
-- the message stay where they are, encrypted. This is what the agent learns
-- from, per person, and it is theirs.
CREATE TABLE corrections (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  kind text NOT NULL CHECK (kind IN ('draft', 'crm_field', 'routine_step')),
  -- The draft, action or run this is about. One correction per thing.
  ref_id uuid NOT NULL,
  contact_address text,
  signals text[] NOT NULL DEFAULT '{}',
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, kind, ref_id)
);

CREATE INDEX idx_corrections_owner_time
  ON corrections (organization_id, owner_user_id, created_at DESC);

ALTER TABLE corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON corrections
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
