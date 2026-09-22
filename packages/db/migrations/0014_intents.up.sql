-- 0014: the intent store.
--
-- What a person means, kept as sentences they can read: stated in their own
-- words, shown by what they did, or inferred and waiting for them to confirm.
-- Encrypted to the person like their mail. Where a sentence is a rule
-- ("don't chase Acme", "never more than twice"), its parsed form is kept
-- beside it in `rule`, in plain structure, so detection can honour it
-- without decrypting anything and with the agent switched off.
CREATE TABLE intents (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  text_ciphertext bytea NOT NULL,
  text_chars integer NOT NULL CHECK (text_chars > 0),
  source text NOT NULL CHECK (source IN ('stated', 'observed', 'inferred')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'proposed', 'retired')),
  scope_kind text NOT NULL CHECK (scope_kind IN ('global', 'contact', 'account', 'situation')),
  scope_value text,
  -- The enforceable form, when the sentence is a rule. Structure only; never the words.
  rule jsonb,
  -- Where it came from: an obligation, a thread, an action. Ids only.
  origin jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

CREATE INDEX idx_intents_owner_active
  ON intents (organization_id, owner_user_id, created_at DESC)
  WHERE status = 'active';

ALTER TABLE intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE intents FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON intents
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- An obligation the person's own rule set aside. Rewritten by each sweep like
-- pending, so retiring the rule brings the item back on the next sync.
ALTER TABLE obligations DROP CONSTRAINT IF EXISTS obligations_outcome_check;
ALTER TABLE obligations ADD CONSTRAINT obligations_outcome_check
  CHECK (outcome IN ('pending', 'drafted', 'snoozed', 'dismissed', 'resolved', 'skipped'));
ALTER TABLE obligations ADD COLUMN applied_intent_id uuid REFERENCES intents (id) ON DELETE SET NULL;

-- How many times the person has written in a row without an answer, at the
-- end of the thread. "Never more than twice" needs this without a body.
ALTER TABLE threads ADD COLUMN chase_count integer NOT NULL DEFAULT 0 CHECK (chase_count >= 0);
