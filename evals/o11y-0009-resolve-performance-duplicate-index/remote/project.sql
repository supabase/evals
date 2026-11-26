-- Broken starting state (probe: performance-duplicate-index / Splinter lint 0009).
-- idx_orders_customer_dup duplicates idx_orders_customer_id — both index
-- orders(customer_id) — wasting write overhead on every INSERT and UPDATE.
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
SELECT 'user' || g || '@example.com' FROM generate_series(1, 100) AS g;

-- Original index.
CREATE INDEX idx_orders_customer_id ON public.orders(customer_id);
-- Duplicate index (identical columns, same table).
CREATE INDEX idx_orders_customer_dup ON public.orders(customer_id);

INSERT INTO public.orders (customer_id, total_cents)
SELECT (floor(random() * 100) + 1)::int, (floor(random() * 10000) + 1)::int
FROM generate_series(1, 5000);
