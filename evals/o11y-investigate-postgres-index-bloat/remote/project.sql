-- Starting state (probe: postgres-index-bloat).
-- Repeated UPDATE operations on orders without VACUUM have caused the btree
-- index on customer_id to accumulate dead pages.
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

CREATE INDEX idx_orders_customer_id ON public.orders(customer_id);

INSERT INTO public.customers (email)
SELECT 'user' || g || '@example.com' FROM generate_series(1, 500) AS g;

INSERT INTO public.orders (customer_id, total_cents)
SELECT (g % 500) + 1, (random() * 10000)::int
FROM generate_series(1, 10000) g;

-- Repeatedly flip values to generate index churn (dead pages accumulate).
DO $$
DECLARE i int;
BEGIN
  FOR i IN 1..20 LOOP
    UPDATE public.orders SET customer_id = ((customer_id % 500) + 1) WHERE id % 2 = 0;
    UPDATE public.orders SET customer_id = ((customer_id % 500) + 1) WHERE id % 2 = 1;
  END LOOP;
END $$;
ANALYZE public.orders;

-- Faked index scan stats (named to avoid collision with pg_stat_user_indexes system view).
CREATE TABLE public.index_scan_stats (
  schemaname name,
  relname name,
  indexrelname name,
  idx_scan bigint,
  idx_tup_read bigint,
  idx_tup_fetch bigint
);

INSERT INTO public.index_scan_stats
  (schemaname, relname, indexrelname, idx_scan, idx_tup_read, idx_tup_fetch)
VALUES
  ('public', 'orders', 'idx_orders_customer_id', 42100, 210000, 198000);

-- Faked index block stats showing high read ratio (bloat indicator).
CREATE TABLE public.index_block_stats (
  schemaname name,
  relname name,
  indexrelname name,
  idx_blks_read bigint,
  idx_blks_hit bigint
);

INSERT INTO public.index_block_stats
  (schemaname, relname, indexrelname, idx_blks_read, idx_blks_hit)
VALUES
  ('public', 'orders', 'idx_orders_customer_id', 85000, 12000);
