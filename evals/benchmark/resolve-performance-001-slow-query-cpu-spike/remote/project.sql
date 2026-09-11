CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

INSERT INTO accounts (name)
SELECT 'account-' || n
FROM generate_series(1, 20) AS n;

INSERT INTO events (user_id, kind, payload, created_at)
SELECT
  ('00000000-0000-0000-0000-' || lpad((((n - 1) % 50) + 1)::text, 12, '0'))::uuid,
  CASE WHEN n % 5 = 0 THEN 'checkout' ELSE 'page_view' END,
  jsonb_build_object('seq', n),
  '2026-04-28T10:00:00Z'::timestamptz - (n || ' seconds')::interval
FROM generate_series(1, 5000) AS n;

-- Eval-scoped compatibility table for Supabase's Query Performance report,
-- which is backed by pg_stat_statements in real projects.
CREATE TABLE pg_stat_statements (
  userid oid NOT NULL DEFAULT 10::oid,
  dbid oid NOT NULL DEFAULT 5::oid,
  queryid bigint PRIMARY KEY,
  query text NOT NULL,
  calls bigint NOT NULL,
  rows bigint NOT NULL DEFAULT 0,
  total_plan_time double precision NOT NULL DEFAULT 0,
  total_exec_time double precision NOT NULL,
  mean_plan_time double precision NOT NULL DEFAULT 0,
  mean_exec_time double precision NOT NULL,
  max_exec_time double precision NOT NULL,
  shared_blks_hit bigint NOT NULL DEFAULT 0,
  shared_blks_read bigint NOT NULL DEFAULT 0,
  shared_blks_dirtied bigint NOT NULL DEFAULT 0,
  shared_blks_written bigint NOT NULL DEFAULT 0
);

INSERT INTO pg_stat_statements (
  queryid,
  query,
  calls,
  rows,
  total_exec_time,
  mean_exec_time,
  max_exec_time,
  shared_blks_hit,
  shared_blks_read
)
VALUES
  (
    824001,
    'SELECT id, kind, payload, created_at FROM events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
    1840,
    92000,
    2498720,
    1358,
    2410,
    522000,
    771000
  ),
  (
    824002,
    'SELECT id, name FROM accounts LIMIT 20',
    960,
    19200,
    11520,
    12,
    31,
    18600,
    80
  ),
  (
    824003,
    'SELECT count(*) FROM events WHERE kind = $1',
    320,
    320,
    7680,
    24,
    74,
    31000,
    240
  );
