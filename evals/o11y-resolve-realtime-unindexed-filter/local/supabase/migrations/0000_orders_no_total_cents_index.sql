-- Broken starting state (probe: realtime-unindexed-filter).
-- Realtime subscription filters on orders.total_cents which has no index;
-- every broadcast triggers a sequential scan.
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
FROM generate_series(1, 20000);

ANALYZE public.orders;

-- No index on total_cents — this is the fault.
-- DROP INDEX IF EXISTS idx_orders_total_cents;
