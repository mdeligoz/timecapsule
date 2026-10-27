-- When a setup run started (milliseconds since 1970, UTC), so a second click waits instead of running setup twice.
ALTER TABLE settings ADD COLUMN setup_started_at INTEGER;

-- When setup finished. Once set, setup never runs again, even from a page the version before setup still serves.
ALTER TABLE settings ADD COLUMN setup_finished_at INTEGER;
