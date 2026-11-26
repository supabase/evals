-- Broken starting state (probe: security-materialized-view-in-api / Splinter lint 0016).
-- public.order_totals is a materialized view — RLS cannot be enforced on
-- materialized views, exposing aggregated revenue data across all customers to
-- any authenticated API caller.
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
SELECT 'user' || g || '@example.com' FROM generate_series(1, 10) AS g;

INSERT INTO public.orders (customer_id, total_cents)
SELECT (floor(random() * 10) + 1)::int, (floor(random() * 10000) + 1)::int
FROM generate_series(1, 500);

CREATE MATERIALIZED VIEW public.order_totals AS
  SELECT customer_id, sum(total_cents) AS total
  FROM public.orders
  GROUP BY customer_id;

GRANT SELECT ON public.order_totals TO authenticated, anon;
