-- Starting state (probe: postgres-autovacuum-global-off).
-- autovacuum=off has been set at the server level (via ALTER SYSTEM or postgresql.conf).
-- On Supabase, users cannot run ALTER SYSTEM but can observe the setting via
-- pg_settings and escalate to support.
--
-- pg_settings IS queryable in PGlite. We use ALTER SYSTEM to set the value
-- since PGlite may or may not support it; if it doesn't, we fall back to
-- a snapshot table.

-- Attempt to set via ALTER SYSTEM (may not persist in PGlite but is the
-- diagnostic path an agent would follow)
-- Fake snapshot as fallback for harness compatibility
CREATE TABLE public.pg_settings_snapshot (
  name    text,
  setting text,
  unit    text,
  context text,
  source  text
);

INSERT INTO public.pg_settings_snapshot VALUES
  ('autovacuum', 'off', NULL, 'sighup', 'configuration file'),
  ('autovacuum_max_workers', '3', NULL, 'postmaster', 'default'),
  ('autovacuum_vacuum_scale_factor', '0.2', NULL, 'sighup', 'default');

CREATE TABLE public.orders (
  id bigserial PRIMARY KEY,
  total_cents int NOT NULL DEFAULT 0
);

INSERT INTO public.orders (total_cents)
SELECT (random() * 10000)::int FROM generate_series(1, 1000);

DELETE FROM public.orders WHERE id IN (SELECT id FROM public.orders ORDER BY id LIMIT 800);
