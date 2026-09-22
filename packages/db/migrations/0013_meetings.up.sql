-- 0013: meetings are an input.
--
-- A meeting carries what a thread cannot: that two people actually spoke,
-- when, about what (the title, the agenda in the description), and whether
-- they are about to speak again. Stored per person, like mail: the
-- description encrypted to them, rows under their row-level security.
-- Contacts carry the two stamps detection and drafting need most, kept
-- current by the sync: the last meeting with that person, and the next.
CREATE TABLE meetings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  connection_id uuid NOT NULL REFERENCES user_connections (id) ON DELETE CASCADE,
  external_id text NOT NULL,
  title text NOT NULL,
  -- The agenda, notes, links. Packed envelope; opaque to the database.
  description_ciphertext bytea,
  description_chars integer NOT NULL DEFAULT 0 CHECK (description_chars >= 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  organizer_address text,
  -- [{ "address", "display_name"?, "response"? }], addresses lower-cased.
  attendees jsonb NOT NULL DEFAULT '[]'::jsonb,
  self_response text NOT NULL DEFAULT 'needsAction'
    CHECK (self_response IN ('accepted', 'tentative', 'declined', 'needsAction')),
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_id)
);

CREATE INDEX idx_meetings_owner_time
  ON meetings (organization_id, owner_user_id, starts_at);
CREATE INDEX idx_meetings_attendees
  ON meetings USING gin (attendees jsonb_path_ops);

ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON meetings
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- The stamps. last_meeting_at existed since 0008 and nothing filled it.
ALTER TABLE contacts ADD COLUMN last_meeting_title text;
ALTER TABLE contacts ADD COLUMN next_meeting_at timestamptz;
ALTER TABLE contacts ADD COLUMN next_meeting_title text;

-- Google Calendar's incremental sync token, per connection. Absent means a
-- full window fetch; 410 from Google means start over.
ALTER TABLE user_connections ADD COLUMN calendar_sync_token text;
