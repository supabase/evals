-- Red-herring CPU spike scenario.
--
-- The real CPU hog is a fast-but-very-frequent per-user lookup on `events`
-- that never crosses the slow-query log threshold, so it is INVISIBLE in the
-- logs. The slow-query logs are instead dominated by a genuinely slow but rare
-- report query on `audit_log`. An agent that diagnoses from the logs (or sorts
-- pg_stat_statements by mean/max time) will "fix" the decoy and leave the CPU
-- spike in place. The only way to the correct fix is ranking
-- pg_stat_statements by total_exec_time (calls x mean_exec_time).

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor uuid NOT NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

INSERT INTO accounts (name)
SELECT 'account-' || n
FROM generate_series(1, 20) AS n;

-- High-frequency hog target: ~120 rows per user across 50 users.
INSERT INTO events (user_id, kind, payload, created_at)
SELECT
  ('00000000-0000-0000-0000-' || lpad((((n - 1) % 50) + 1)::text, 12, '0'))::uuid,
  CASE WHEN n % 5 = 0 THEN 'checkout' ELSE 'page_view' END,
  jsonb_build_object('seq', n),
  '2026-04-28T10:00:00Z'::timestamptz - (n || ' seconds')::interval
FROM generate_series(1, 6000) AS n;

-- Decoy table for the slow-but-rare report query that fills the logs.
INSERT INTO audit_log (actor, action, details, created_at)
SELECT
  ('00000000-0000-0000-0000-' || lpad((((n - 1) % 50) + 1)::text, 12, '0'))::uuid,
  (ARRAY['login', 'logout', 'update_profile', 'delete_account', 'export_data'])[(n % 5) + 1],
  jsonb_build_object('seq', n),
  '2026-04-28T10:00:00Z'::timestamptz - (n || ' seconds')::interval
FROM generate_series(1, 8000) AS n;

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

-- Stats deliberately diverge by ranking dimension:
--   total_exec_time  -> events hog dominates (~99%): the correct culprit.
--   mean/max_exec_time -> audit_log report wins: the decoy the logs point at.
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
  -- Real CPU hog: tiny per-call, enormous call count, dominant total time.
  -- Below the slow-query log threshold, so it never appears in logs.jsonl.
  (
    841001,
    'SELECT id, kind, payload, created_at FROM events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
    486000,
    24300000,
    10692000,
    22,
    160,
    9100000,
    7400000
  ),
  -- Decoy: genuinely slow per call but rare, so total time is negligible.
  -- Tops the slow-query logs and the mean/max columns.
  (
    841002,
    'SELECT id, actor, action, details, created_at FROM audit_log WHERE action = $1 ORDER BY created_at DESC LIMIT 100',
    14,
    1400,
    43680,
    3120,
    3520,
    420,
    96000
  ),
  (
    841003,
    'SELECT id, name FROM accounts LIMIT 20',
    900,
    18000,
    9900,
    11,
    28,
    17400,
    60
  ),
  (
    841004,
    'SELECT count(*) FROM audit_log WHERE action = $1',
    210,
    210,
    5040,
    24,
    70,
    20300,
    180
  );
