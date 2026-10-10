-- Broken starting state (probe: performance-missing-index).
-- orders.customer_id is unindexed, so the hot per-customer lookup does a
-- sequential scan over a large table.
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
SELECT 'user' || g || '@example.com'
FROM generate_series(1, 500) AS g;

-- 50k orders, no index on customer_id.
INSERT INTO public.orders (customer_id, total_cents)
SELECT (floor(random() * 500) + 1)::int,
       (floor(random() * 10000) + 1)::int
FROM generate_series(1, 50000);

ANALYZE public.orders;
