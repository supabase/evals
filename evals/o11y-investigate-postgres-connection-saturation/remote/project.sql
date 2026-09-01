-- Starting state (probe: postgres-connection-saturation).
-- HARNESS NOTE: Cannot produce real concurrent sessions in the eval harness.
-- Faked pg_stat_activity snapshot showing 90 idle connections from pg_cron.
CREATE TABLE public.orders (
  id bigserial PRIMARY KEY,
  customer_id int NOT NULL DEFAULT 1,
  total_cents int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Faked pg_stat_activity snapshot showing connection saturation.
CREATE TABLE IF NOT EXISTS pg_stat_activity_snapshot (
  pid int PRIMARY KEY,
  application_name text,
  state text,
  query text,
  wait_event_type text,
  wait_event text,
  query_start timestamptz,
  backend_start timestamptz
);

INSERT INTO pg_stat_activity_snapshot
  (pid, application_name, state, query, wait_event_type, wait_event, query_start, backend_start)
SELECT
  50000 + g,
  'pg_cron',
  'idle in transaction',
  'SELECT pg_sleep(120)',
  'Timeout',
  'pg_sleep',
  now() - ((random() * 60) || ' seconds')::interval,
  now() - '2 minutes'::interval
FROM generate_series(1, 90) g;

-- Remaining connections: very few left.
INSERT INTO pg_stat_activity_snapshot
  (pid, application_name, state, query, wait_event_type, query_start, backend_start)
VALUES
  (1001, 'PostgREST', 'active', 'SELECT * FROM orders LIMIT 10', NULL, now(), now() - '1 second'::interval),
  (1002, 'supabase-pooler', 'idle', '', 'Client', now(), now() - '30 seconds'::interval);
