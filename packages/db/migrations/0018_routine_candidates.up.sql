-- 0018: routines the agent found. Phase 3, step 2.
--
-- One row per routine shape discovery has seen forming in a person's event
-- stream, keyed by the routine's signature (its canonical step sequence).
-- The engine rewrites the candidate, its scores and the verdict on every
-- sweep; the person's decision on it (not now, never, accepted) is theirs
-- and survives the rewrite. Per person, like the events it comes from.
CREATE TABLE routine_candidates (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  signature text NOT NULL,
  -- The engine's word: candidate (still forming) or eligible (cleared every bar).
  status text NOT NULL CHECK (status IN ('candidate', 'eligible')),
  -- "Not now", which lapses after the cooldown. "Accepted" and "never" are
  -- entries in the intent store, in the person's words, where they can be
  -- read and forgotten; they are not kept here a second time.
  decision text CHECK (decision IN ('dismissed')),
  decided_at timestamptz,
  -- The compiled agent behind an accepted routine (agents.id), once it exists.
  agent_id uuid,
  title text NOT NULL,
  summary text NOT NULL,
  occurrence_count integer NOT NULL,
  distinct_day_count integer NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  -- The candidate as the engine shaped it, the naming, and every bar with
  -- its verdict. Sequences, scores, hashes and ids; never content.
  candidate jsonb NOT NULL,
  naming jsonb NOT NULL,
  verdict jsonb NOT NULL,
  -- The episodes behind it: when each ran, the case it ran around (a hash),
  -- how many events. The person checks the claim against these.
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  evaluated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, signature)
);

CREATE INDEX idx_routine_candidates_owner
  ON routine_candidates (organization_id, owner_user_id, status, last_seen_at DESC);

ALTER TABLE routine_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE routine_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON routine_candidates
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
