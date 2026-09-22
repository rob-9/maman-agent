-- 0013 down.
ALTER TABLE user_connections DROP COLUMN IF EXISTS calendar_sync_token;
ALTER TABLE contacts DROP COLUMN IF EXISTS next_meeting_title;
ALTER TABLE contacts DROP COLUMN IF EXISTS next_meeting_at;
ALTER TABLE contacts DROP COLUMN IF EXISTS last_meeting_title;
DROP TABLE IF EXISTS meetings;
