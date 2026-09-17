-- Starting state (probe: postgres-autovacuum-starved).
-- public.audit_log has 480,000 dead tuples with no autovacuum in 5 days.
-- public.events has 95,000 dead tuples with no autovacuum in 3 days.
-- Both are above the default vacuum threshold (scale_factor=0.2 × reltuples + threshold=50).
-- HARNESS NOTE: pg_stat_user_tables system view cannot be seeded in PGlite.

CREATE TABLE public.pg_stat_user_tables_snapshot (
  schemaname         name,
  relname            name,
  n_live_tup         bigint,
  n_dead_tup         bigint,
  n_mod_since_analyze bigint,
  last_vacuum        timestamptz,
  last_autovacuum    timestamptz,
  last_analyze       timestamptz,
  last_autoanalyze   timestamptz,
  vacuum_count       bigint,
  autovacuum_count   bigint
);

INSERT INTO public.pg_stat_user_tables_snapshot VALUES
  ('public', 'audit_log',  120000, 480000, 480000, NULL, now() - '5 days'::interval,    NULL, now() - '5 days'::interval,  0, 2),
  ('public', 'events',      85000,  95000,  95000, NULL, now() - '3 days'::interval,    NULL, now() - '3 days'::interval,  0, 5),
  ('public', 'users',        5000,     40,     80, NULL, now() - '2 hours'::interval,   NULL, now() - '2 hours'::interval, 0, 48),
  ('public', 'sessions',    12000,    200,    400, NULL, now() - '90 minutes'::interval, NULL, now() - '90 minutes'::interval, 0, 12);
