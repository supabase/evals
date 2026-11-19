-- Broken starting state (probe: api-missing-grant).
-- SELECT has been revoked from anon on public.orders, so unauthenticated Data
-- API requests return permission denied instead of rows.
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
FROM generate_series(1, 200);

-- Revoke SELECT from anon — this is the fault.
REVOKE SELECT ON public.orders FROM anon;
