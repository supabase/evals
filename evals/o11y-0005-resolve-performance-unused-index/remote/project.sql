-- Broken starting state (probe: performance-unused-index / Splinter lint 0005).
-- idx_unused_total indexes orders(total_cents) but no query ever filters by
-- total_cents, so it adds write overhead on every INSERT/UPDATE without
-- benefiting any read. Seeded index_usage_stats shows zero scans.
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
-- The unused index: no query ever filters by total_cents.
CREATE INDEX idx_unused_total ON public.orders(total_cents);

INSERT INTO public.customers (email)
SELECT 'user' || g || '@example.com' FROM generate_series(1, 100) AS g;

INSERT INTO public.orders (customer_id, total_cents)
SELECT (floor(random() * 100) + 1)::int, (floor(random() * 10000) + 1)::int
FROM generate_series(1, 5000);

-- Faked index usage stats (named to avoid collision with pg_stat_user_indexes system view).
CREATE TABLE public.index_usage_stats (
  schemaname name,
  relname name,
  indexrelname name,
  idx_scan bigint,
  idx_tup_read bigint,
  idx_tup_fetch bigint
);

INSERT INTO public.index_usage_stats
  (schemaname, relname, indexrelname, idx_scan, idx_tup_read, idx_tup_fetch)
VALUES
  ('public', 'orders', 'idx_orders_customer_id', 184022, 921000, 840000),
  ('public', 'orders', 'idx_unused_total',         0,       0,       0);
