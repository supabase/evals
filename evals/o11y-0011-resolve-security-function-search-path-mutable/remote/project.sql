-- Broken starting state (probe: security-function-search-path-mutable / Splinter lint 0011).
-- get_customer_balance() is SECURITY DEFINER with no SET search_path, allowing
-- search_path injection if an attacker can create objects in any schema on the
-- search path.
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

-- The vulnerable function: SECURITY DEFINER with mutable search_path.
CREATE OR REPLACE FUNCTION public.get_customer_balance(p_customer_id int)
  RETURNS bigint
  LANGUAGE sql
  SECURITY DEFINER
  -- intentionally omitting SET search_path = '' to trigger lint 0011
  AS $$
    SELECT coalesce(sum(total_cents), 0)
    FROM public.orders
    WHERE customer_id = p_customer_id;
  $$;
