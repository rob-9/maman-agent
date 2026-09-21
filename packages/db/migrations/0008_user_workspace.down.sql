-- 0008 down. Dependency order: obligations and threads reference contacts,
-- which reference user_connections. Policies drop with their tables.

DROP INDEX IF EXISTS idx_obligations_owner_rank;
DROP TABLE IF EXISTS obligations;
DROP INDEX IF EXISTS idx_threads_owner_recent;
DROP TABLE IF EXISTS threads;
DROP TABLE IF EXISTS contacts;
DROP TABLE IF EXISTS user_connections;
