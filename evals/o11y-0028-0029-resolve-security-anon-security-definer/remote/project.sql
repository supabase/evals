-- Broken starting state (probe: security-anon-security-definer / Splinter lint 0028).
-- public.admin_stats() is SECURITY DEFINER and GRANTed to anon, allowing
-- unauthenticated API callers to execute it as the function owner.
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
FROM generate_series(1, 100);

CREATE OR REPLACE FUNCTION public.admin_stats()
  RETURNS json
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = ''
  AS $$
    SELECT json_build_object(
      'total_orders', count(*),
      'total_revenue', sum(total_cents)
    ) FROM public.orders;
  $$;

GRANT EXECUTE ON FUNCTION public.admin_stats() TO anon;
