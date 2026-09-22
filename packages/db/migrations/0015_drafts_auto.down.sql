-- 0015 down.
DROP INDEX IF EXISTS idx_drafts_owner_thread_unmatched;
ALTER TABLE drafts DROP COLUMN IF EXISTS mode;
ALTER TABLE drafts DROP COLUMN IF EXISTS gmail_message_id;
