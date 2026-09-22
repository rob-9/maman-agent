-- 0012: what the agent wrote, and what the person actually sent.
--
-- A draft we produced is recorded (body encrypted to the person, like mail).
-- When a later sync sees an outbound message on that thread, the draft is
-- matched to it and the edit ratio recorded: 1.0 means sent as written, 0
-- means rewritten. That number is the product's own measure of its voice,
-- and the sent message itself becomes a voice exemplar for the next draft.
CREATE TABLE drafts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  -- The obligation it answered. Nullable: the sweep rewrites pending obligations,
  -- and the record of what was drafted must outlive that row.
  obligation_id uuid REFERENCES obligations (id) ON DELETE SET NULL,
  thread_id uuid NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  gmail_draft_id text NOT NULL,
  subject text NOT NULL,
  body_ciphertext bytea NOT NULL,
  body_chars integer NOT NULL CHECK (body_chars >= 0),
  composer text NOT NULL CHECK (composer IN ('deterministic', 'model')),
  model_alias text,
  fallback_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Filled when a later outbound message on the thread is matched to this draft.
  sent_external_id text,
  sent_at timestamptz,
  edit_ratio numeric(4, 3) CHECK (edit_ratio IS NULL OR (edit_ratio >= 0 AND edit_ratio <= 1)),
  matched_at timestamptz
);

CREATE INDEX idx_drafts_owner_unmatched
  ON drafts (organization_id, owner_user_id, thread_id)
  WHERE matched_at IS NULL;

ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON drafts
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
