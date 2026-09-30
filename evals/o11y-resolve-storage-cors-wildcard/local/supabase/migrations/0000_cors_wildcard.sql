-- Starting state (probe: storage-cors-wildcard).
-- NOTE: CORS is a platform-level setting in config.toml, not SQL-configurable.
-- This migration creates a representative bucket so the agent has something to
-- inspect, but the core issue (wildcard CORS) is only visible via config/docs.
INSERT INTO storage.buckets (id, name, public, created_at, updated_at)
VALUES ('assets', 'assets', false, now(), now())
ON CONFLICT (id) DO NOTHING;
