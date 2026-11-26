-- Starting state (probe: postgres-idle-in-transaction).
-- HARNESS NOTE: pg_stat_activity is a system view in PGlite and reflects only
-- internal harness state. Session data is seeded in a snapshot table.

CREATE TABLE public.orders (
  id bigserial PRIMARY KEY,
  customer_id bigint NOT NULL,
  total_cents int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.pg_stat_activity_snapshot (
  pid              int,
  usename          text,
  application_name text,
  state            text,
  wait_event_type  text,
  wait_event       text,
  query            text,
  query_start      timestamptz,
  state_change     timestamptz,
  xact_start       timestamptz,
  backend_start    timestamptz
);

-- pid 55321: idle in transaction for 47 minutes — holding back vacuum horizon
-- across the entire cluster, not just its own table.
INSERT INTO public.pg_stat_activity_snapshot VALUES
  (55321, 'app_user', 'rails-app', 'idle in transaction', NULL, NULL,
   'SELECT id FROM public.orders WHERE id = 42',
   now() - '47 minutes'::interval,
   now() - '47 minutes'::interval,
   now() - '47 minutes'::interval,
   now() - '2 hours'::interval),
  (55322, 'app_user', 'rails-app', 'active', NULL, NULL,
   'INSERT INTO public.orders (customer_id, total_cents) VALUES ($1, $2)',
   now() - '120 milliseconds'::interval,
   now() - '120 milliseconds'::interval,
   now() - '120 milliseconds'::interval,
   now() - '2 hours'::interval),
  (55323, 'readonly', 'dashboard', 'idle', NULL, NULL,
   'SELECT count(*) FROM public.orders',
   now() - '5 seconds'::interval,
   now() - '4 seconds'::interval,
   NULL,
   now() - '30 minutes'::interval);
