-- Starting state (probe: api-embedding-nplus1).
-- Resource embedding (?select=*,line_items(*)) generates a correlated
-- subquery per order row because line_items.order_id has no index.
-- Each outer row triggers a seq scan on line_items, producing N+1 behaviour
-- at the database level. Evidence lives in faked query statistics.

CREATE TABLE public.orders (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  total_cents int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.line_items (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES public.orders(id),
  product_name text NOT NULL,
  quantity int NOT NULL DEFAULT 1,
  unit_cents int NOT NULL DEFAULT 0
  -- Intentionally no index on order_id
);

INSERT INTO public.orders (user_id, status, total_cents)
SELECT
  gen_random_uuid(),
  (ARRAY['pending','complete','cancelled'])[floor(random()*3+1)::int],
  (floor(random() * 50000) + 500)::int
FROM generate_series(1, 2000);

INSERT INTO public.line_items (order_id, product_name, quantity, unit_cents)
SELECT
  (floor(random() * 2000) + 1)::int,
  'Product ' || (floor(random() * 50) + 1)::int,
  (floor(random() * 5) + 1)::int,
  (floor(random() * 5000) + 100)::int
FROM generate_series(1, 10000);

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
  -- Outer query: fetching a page of orders — reasonable.
  (6001,
   'SELECT "orders"."id", "orders"."user_id", "orders"."status", "orders"."total_cents", "orders"."created_at" FROM "orders" ORDER BY "orders"."created_at" DESC LIMIT $1 OFFSET $2',
   9200, 460000, 46000.0, 5.0, 22.0, 2300000, 18000),
  -- Inner correlated subquery: one seq scan on line_items per order row.
  -- calls ≈ 50 × outer calls (50 orders per page × 9200 outer calls).
  -- High blks_read signals seq scan; high total_exec_time is the real cost.
  (6002,
   'SELECT "line_items"."id", "line_items"."order_id", "line_items"."product_name", "line_items"."quantity", "line_items"."unit_cents" FROM "line_items" WHERE "line_items"."order_id" = $1',
   460000, 2300000, 24840000.0, 54.0, 310.0, 1800000, 9200000),
  -- Fast unrelated query for contrast.
  (6003,
   'SELECT "orders"."id", "orders"."status" FROM "orders" WHERE "orders"."user_id" = $1',
   3800, 19000, 760.0, 0.2, 3.0, 95000, 800);
