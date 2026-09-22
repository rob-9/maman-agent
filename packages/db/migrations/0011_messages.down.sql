-- 0011 down. Threads and obligations never depended on stored content.
ALTER TABLE threads DROP COLUMN IF EXISTS history_id;
DROP TABLE IF EXISTS messages;
