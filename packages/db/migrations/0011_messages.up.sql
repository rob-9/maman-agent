-- 0011: mail content is an input.
--
-- The agent reads the whole conversation, not the headers. Bodies are synced
-- and stored per person, ENCRYPTED AT REST with the person-bound envelope key
-- (AAD names the organization, the user and the provider), under the same
-- row-level security as everything else the person owns. Only that person's
-- agent decrypts them: never an admin, never a log, never analytics. A breach
-- of this table yields ciphertext.
CREATE TABLE messages (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  thread_id uuid NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  external_id text NOT NULL,
  from_address text NOT NULL,
  from_display_name text,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sent_at timestamptz NOT NULL,
  -- Packed envelope (see connector-auth packEnvelope). Opaque to the database.
  body_ciphertext bytea NOT NULL,
  -- Plaintext length, so bounds and voice sampling work without decrypting.
  body_chars integer NOT NULL CHECK (body_chars >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, external_id)
);

CREATE INDEX idx_messages_owner_thread
  ON messages (organization_id, owner_user_id, thread_id, sent_at);
CREATE INDEX idx_messages_owner_outbound
  ON messages (organization_id, owner_user_id, sent_at DESC)
  WHERE direction = 'outbound';

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON messages
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- Gmail's per-thread history id. A thread whose id has not moved since the
-- last sync is not fetched again, which is what makes a full-content sync
-- affordable every fifteen minutes.
ALTER TABLE threads ADD COLUMN history_id text;
