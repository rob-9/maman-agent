-- 0008: the per-user workspace — connections, synced projections, obligations.
--
-- TWO-LEVEL TENANCY, and the inner level is the strict one.
--
-- Every table before this one isolates on organization_id alone, which is
-- correct for org-owned things like policies and audit. These tables hold one
-- person's inbox, pipeline and dropped balls, and a colleague — INCLUDING their
-- manager — must not read them. So the policy requires BOTH ids.
--
-- An unset setting must yield NO ROWS, not an error.
--
-- `current_setting(x, true)` returns NULL only while a custom GUC has NEVER
-- been set in the session. Once any transaction has set it, a transaction-local
-- set reverts to the EMPTY STRING — and `''::uuid` raises
-- "invalid input syntax for type uuid". So the obvious spelling makes an
-- org-scoped read of these tables throw rather than return nothing.
--
-- NULLIF maps both cases to NULL, and `col = NULL` is NULL rather than true, so
-- a transaction that forgot to set app.user_id reads nothing at all.
-- Fail-closed by construction: the mistake is an empty result, never an
-- exception and never another person's mail.
--
-- Admin reporting does NOT read these tables. Aggregates come from a separate,
-- deliberate path with a minimum cohort — org membership is not read permission.

-- Per-user OAuth grants. One row per (user, provider) connection.
CREATE TABLE user_connections (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  provider text NOT NULL,
  -- The account this grant is for, as the provider names it. Used to tell the
  -- user WHICH mailbox is connected; never used as an identity.
  external_account_label text NOT NULL,
  -- Envelope-encrypted refresh material. Never returned by any API response,
  -- never logged. Ciphertext only: a plaintext token here is a reportable bug.
  encrypted_credentials bytea NOT NULL,
  scopes text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'expired', 'revoked', 'error')),
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, owner_user_id, provider, external_account_label)
);

-- A person the user deals with, projected from whichever connector supplied it.
CREATE TABLE contacts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  connection_id uuid NOT NULL REFERENCES user_connections (id) ON DELETE CASCADE,
  -- The id the source system uses. Scoped per connection so two CRMs cannot
  -- collide on an opaque id.
  external_id text NOT NULL,
  display_name text NOT NULL,
  account_name text,
  -- Deal state drives detection: a closed relationship owes nothing.
  has_open_deal boolean NOT NULL DEFAULT false,
  open_deal_value numeric(14, 2) CHECK (open_deal_value IS NULL OR open_deal_value >= 0),
  last_meeting_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_id)
);

-- A conversation. CONTENT-FREE ON PURPOSE.
--
-- Detection needs a subject, a direction and a timestamp; it never needs a
-- body. Bodies are fetched on demand for the one thread the user asked to draft
-- against, and are not stored here. Keeping message text out of the database
-- means a breach of this table leaks who someone talks to, not what they said.
CREATE TABLE threads (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  connection_id uuid NOT NULL REFERENCES user_connections (id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  external_id text NOT NULL,
  subject text NOT NULL,
  last_message_at timestamptz NOT NULL,
  last_direction text NOT NULL CHECK (last_direction IN ('inbound', 'outbound')),
  message_count integer NOT NULL CHECK (message_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_id)
);

CREATE INDEX idx_threads_owner_recent
  ON threads (organization_id, owner_user_id, last_message_at DESC);

-- A detected obligation. Rewritten wholesale by each detection sweep.
--
-- `reason` is the FACTS that produced it, not rendered copy: days elapsed, the
-- threshold applied, direction, deal state. The UI writes the sentence. A
-- reviewer can re-check the arithmetic without re-running the detector, and a
-- suggestion that cannot explain itself cannot be shipped.
CREATE TABLE obligations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  thread_id uuid NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('awaiting_you', 'awaiting_them', 'unsent_followup')),
  rank numeric(10, 4) NOT NULL CHECK (rank >= 0),
  reason jsonb NOT NULL,
  -- What the user did about it. `pending` until they act.
  outcome text NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'drafted', 'snoozed', 'dismissed', 'resolved')),
  snoozed_until timestamptz,
  detected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One live obligation per thread. A sweep that produced a second would show
  -- the same dropped ball twice.
  UNIQUE (thread_id)
);

CREATE INDEX idx_obligations_owner_rank
  ON obligations (organization_id, owner_user_id, rank DESC)
  WHERE outcome = 'pending';

-- ---------------------------------------------------------------- RLS -------
-- Both ids, on every table. See the header: an unset app.user_id yields NULL,
-- which matches nothing, so a forgotten setting reads zero rows.

ALTER TABLE user_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON user_connections
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON contacts
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON threads
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

ALTER TABLE obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE obligations FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON obligations
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
