-- Starting state (probe: postgres-vacuum-horizon-blocked).
-- Two blockers: (1) a long-running read transaction (pid 77001) holding an old
-- xmin, and (2) an inactive replication slot (stale_slot) also holding the horizon.
-- Either alone would prevent VACUUM from removing dead tuples.
-- HARNESS NOTE: system views cannot be seeded in PGlite; snapshot tables are used.

CREATE TABLE public.orders (
  id bigserial PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);

-- Long-running read transaction holding an old snapshot
CREATE TABLE public.pg_stat_activity_snapshot (
  pid              int,
  usename          text,
  application_name text,
  state            text,
  wait_event_type  text,
  wait_event       text,
  query            text,
  xact_start       timestamptz,
  query_start      timestamptz,
  state_change     timestamptz
);

INSERT INTO public.pg_stat_activity_snapshot VALUES
  (77001, 'reporting', 'analytics-job', 'active', NULL, NULL,
   'SELECT * FROM public.orders',
   now() - '2 hours 15 minutes'::interval,
   now() - '2 hours 15 minutes'::interval,
   now() - '2 hours 15 minutes'::interval),
  (77002, 'app_user', 'api-server', 'idle', NULL, NULL,
   'SELECT 1',
   now() - '10 seconds'::interval,
   now() - '10 seconds'::interval,
   now() - '5 seconds'::interval);

-- Inactive replication slot also holding WAL and the vacuum horizon
CREATE TABLE public.replication_slots_snapshot (
  slot_name            text,
  plugin               text,
  slot_type            text,
  active               boolean,
  active_pid           int,
  restart_lsn          text,
  confirmed_flush_lsn  text,
  wal_status           text,
  safe_wal_size        bigint
);

INSERT INTO public.replication_slots_snapshot VALUES
  ('stale_slot', 'pgoutput', 'logical', false, null,
   '0/A000000', '0/B000000', 'lost', -1073741824);
