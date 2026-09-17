-- Broken starting state (probe: security-security-definer-view / Splinter lint 0010).
-- public.order_summary is a SECURITY DEFINER view (Postgres default for views),
-- bypassing RLS on the underlying orders table for any caller with SELECT on the view.
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
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

INSERT INTO public.customers (email)
SELECT 'user' || g || '@example.com' FROM generate_series(1, 10) AS g;

INSERT INTO public.orders (customer_id, total_cents)
SELECT (floor(random() * 10) + 1)::int, (floor(random() * 10000) + 1)::int
FROM generate_series(1, 500);

-- Postgres views default to SECURITY DEFINER; no extra DDL needed to inject.
CREATE OR REPLACE VIEW public.order_summary AS
  SELECT customer_id, count(*) AS order_count, sum(total_cents) AS total_cents
  FROM public.orders
  GROUP BY customer_id;

GRANT SELECT ON public.order_summary TO authenticated;
