-- Starting state (probe: api-slow-endpoint).
-- GET /rest/v1/orders is slow (~2.3s). The orders table is filtered by
-- user_id but has no index on that column, causing a sequential scan
-- on every request. Evidence lives in faked query statistics.

CREATE TABLE public.customers (
  id serial PRIMARY KEY,
  email text UNIQUE NOT NULL
);

CREATE TABLE public.orders (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  customer_id int NOT NULL REFERENCES public.customers(id),
  total_cents int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
  -- Intentionally no index on user_id
);

INSERT INTO public.customers (email)
SELECT 'user' || g || '@example.com' FROM generate_series(1, 200) AS g;

INSERT INTO public.orders (user_id, customer_id, total_cents, status)
SELECT
  gen_random_uuid(),
  (floor(random() * 200) + 1)::int,
  (floor(random() * 10000) + 1)::int,
  (ARRAY['pending','complete','cancelled'])[floor(random()*3+1)::int]
FROM generate_series(1, 50000);

-- Eval-scoped compatibility table for Supabase's Query Performance report,
-- backed by pg_stat_statements in real projects.
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
  -- The slow offender: sequential scan on orders because user_id has no index.
  -- High blks_read vs blks_hit ratio signals a seq scan touching many pages.
  (3001,
   'SELECT "orders"."id", "orders"."user_id", "orders"."customer_id", "orders"."total_cents", "orders"."status", "orders"."created_at" FROM "orders" WHERE "orders"."user_id" = $1 ORDER BY "orders"."created_at" DESC',
   18420, 92100, 42700000.0, 2319.0, 3801.0, 42000, 890000),
  -- Fast queries for contrast.
  (3002,
   'SELECT "customers"."id", "customers"."email" FROM "customers" WHERE "customers"."id" = $1',
   9200, 9200, 920.0, 0.10, 1.4, 55000, 200),
  (3003,
   'INSERT INTO "orders" ("user_id", "customer_id", "total_cents", "status") VALUES ($1, $2, $3, $4)',
   4100, 4100, 820.0, 0.20, 3.1, 24600, 600);
