-- Starting state (probe: postgres-slow-query).
-- A chaos function runs a full sequential scan + random sort on orders periodically.
-- The evidence lives in faked query statistics.
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
FROM generate_series(1, 10000);

-- Faked pg_stat_statements showing chaos_slow_scan as a consistently slow query.
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
  -- chaos_slow_scan: full seq scan + ORDER BY random() every 3 minutes.
  (2001,
   'SELECT count(*) FROM public.orders ORDER BY random()',
   142, 142, 2840000.0, 20000.0, 24500.0, 0, 820000),
  -- Normal queries for contrast.
  (2002, 'SELECT id, total_cents FROM orders WHERE customer_id = $1', 95120, 95120, 1904.0, 0.02, 0.8, 480000, 1200),
  (2003, 'INSERT INTO orders (customer_id, total_cents) VALUES ($1, $2)', 8800, 8800, 528.0, 0.06, 1.2, 44000, 800);
