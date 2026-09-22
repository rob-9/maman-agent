-- 0015: drafts written before being asked.
--
-- The sweep now drafts the top items on its own. A draft stays attached to a
-- pending obligation (the card says "draft ready" and links to it) until the
-- person sends it, snoozes the item, or says it is not needed. `mode` says
-- whether a click or the sweep produced it; `gmail_message_id` is what Gmail
-- needs to open the draft.
ALTER TABLE drafts ADD COLUMN gmail_message_id text;
ALTER TABLE drafts ADD COLUMN mode text NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'auto'));
CREATE INDEX idx_drafts_owner_thread_unmatched
  ON drafts (organization_id, owner_user_id, thread_id, created_at DESC)
  WHERE matched_at IS NULL;
