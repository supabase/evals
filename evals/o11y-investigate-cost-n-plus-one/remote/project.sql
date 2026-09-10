-- Starting state (probe: cost-n-plus-one).
-- The app fetches each customer's latest order one row at a time (an N+1
-- pattern) instead of a single set-based query. The evidence lives in query
-- statistics: thousands of near-identical single-row selects against orders.
CREATE TABLE public.customers (
  id serial PRIMARY KEY,
  email text UNIQUE NOT NULL
);

CREATE TABLE public.orders (
  id bigserial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES public.customers(id),
  total_cents int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

INSERT INTO public.customers (email)
SELECT 'user' || g || '@example.com' FROM generate_series(1, 500) AS g;

INSERT INTO public.orders (customer_id, total_cents)
SELECT (floor(random() * 500) + 1)::int, (floor(random() * 10000) + 1)::int
FROM generate_series(1, 5000);

-- Eval-scoped compatibility table for Supabase's Query Performance report,
-- which is backed by pg_stat_statements in real projects.
CREATE TABLE pg_stat_statements (
  userid oid NOT NULL DEFAULT 10::oid,
  dbid oid NOT NULL DEFAULT 5::oid,
  queryid bigint PRIMARY KEY,
  query text NOT NULL,
  calls bigint NOT NULL,
  rows bigint NOT NULL DEFAULT 0,
  total_exec_time double precision NOT NULL,
  mean_exec_time double precision NOT NULL,
  max_exec_time double precision NOT NULL,
  shared_blks_hit bigint NOT NULL DEFAULT 0,
  shared_blks_read bigint NOT NULL DEFAULT 0
);

INSERT INTO pg_stat_statements
  (queryid, query, calls, rows, total_exec_time, mean_exec_time, max_exec_time,
   shared_blks_hit, shared_blks_read)
VALUES
  -- The N+1 offender: called once per customer, per page load, for weeks.
  (1001,
   'SELECT id, total_cents, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1',
   1840233, 1840233, 5153000.0, 2.8, 41.2, 9100000, 220000),
  -- A handful of normal, low-frequency queries for contrast.
  (1002, 'SELECT id, email FROM customers WHERE id = $1', 5120, 5120, 610.0, 0.12, 3.1, 41000, 900),
  (1003, 'INSERT INTO orders (customer_id, total_cents) VALUES ($1, $2)', 4990, 4990, 980.0, 0.20, 6.0, 30000, 700),
  (1004, 'SELECT count(*) FROM customers', 88, 88, 44.0, 0.5, 2.0, 900, 10);
