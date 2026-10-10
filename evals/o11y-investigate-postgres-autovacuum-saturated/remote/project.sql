-- Starting state (probe: postgres-autovacuum-saturated).
-- All 3 autovacuum_max_workers slots are in use simultaneously and have been
-- for over 10 minutes — the pool is saturated and tables are queuing.
-- HARNESS NOTE: system views cannot be seeded in PGlite — snapshot tables used.

CREATE TABLE public.pg_stat_activity_snapshot (
  pid              int,
  usename          text,
  application_name text,
  state            text,
  wait_event_type  text,
  wait_event       text,
  query            text,
  query_start      timestamptz,
  backend_type     text
);

INSERT INTO public.pg_stat_activity_snapshot VALUES
  (91001, 'autovacuum', '', 'active', NULL, NULL,
   'autovacuum: VACUUM public.orders (to prevent wraparound)',
   now() - '12 minutes'::interval, 'autovacuum worker'),
  (91002, 'autovacuum', '', 'active', NULL, NULL,
   'autovacuum: VACUUM public.events',
   now() - '11 minutes 30 seconds'::interval, 'autovacuum worker'),
  (91003, 'autovacuum', '', 'active', NULL, NULL,
   'autovacuum: VACUUM ANALYZE public.sessions',
   now() - '10 minutes 45 seconds'::interval, 'autovacuum worker');

-- GUC settings for cross-reference
CREATE TABLE public.pg_settings_snapshot (
  name    text,
  setting text
);

INSERT INTO public.pg_settings_snapshot VALUES
  ('autovacuum', 'on'),
  ('autovacuum_max_workers', '3');
