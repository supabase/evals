-- Starting state (probe: postgres-blocking-chains).
-- HARNESS NOTE: pg_locks and pg_stat_activity are system views in PGlite and
-- cannot be seeded with artificial lock state. The blocking chain is represented
-- in snapshot tables using text/int for PGlite-compatible types.

-- Session snapshot: pid 12345 holds a row lock on orders; pid 23456 and pid 34567
-- are waiting on it in a chain.
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
  backend_start    timestamptz
);

INSERT INTO public.pg_stat_activity_snapshot VALUES
  (12345, 'app_user', 'app-server', 'idle in transaction', NULL, NULL,
   'UPDATE public.orders SET status = ''processing'' WHERE id = 9001',
   now() - '4 minutes'::interval, now() - '4 minutes'::interval, now() - '1 hour'::interval),
  (23456, 'app_user', 'app-server', 'active', 'Lock', 'relation',
   'UPDATE public.orders SET status = ''shipped'' WHERE id = 9001',
   now() - '3 minutes 50 seconds'::interval, now() - '3 minutes 50 seconds'::interval, now() - '1 hour'::interval),
  (34567, 'reporting', 'metabase', 'active', 'Lock', 'relation',
   'SELECT * FROM public.orders WHERE status = ''processing''',
   now() - '3 minutes 40 seconds'::interval, now() - '3 minutes 40 seconds'::interval, now() - '30 minutes'::interval);

-- Lock snapshot: pid 12345 holds ExclusiveLock; pids 23456 and 34567 are waiting
CREATE TABLE public.pg_locks_snapshot (
  locktype    text,
  relation    text,
  mode        text,
  granted     boolean,
  pid         int,
  blocking_pid int
);

INSERT INTO public.pg_locks_snapshot VALUES
  ('tuple', 'orders', 'ExclusiveLock',  true,  12345, NULL),
  ('tuple', 'orders', 'ExclusiveLock',  false, 23456, 12345),
  ('relation', 'orders', 'RowShareLock', false, 34567, 12345);

-- Actual tables for context
CREATE TABLE public.orders (
  id bigserial PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending'
);
