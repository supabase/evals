-- Broken starting state (probe: health-rls-policy-exists-disabled / Splinter lint 0007).
-- public.orders has a SELECT policy defined but RLS is disabled — the policy
-- exists and looks intentional but is silently not enforced.
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

-- Policy exists but RLS is disabled — policy never evaluated.
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "orders_select_own" ON public.orders
  FOR SELECT TO authenticated
  USING (customer_id IN (SELECT id FROM public.customers WHERE email = auth.email()));
ALTER TABLE public.orders DISABLE ROW LEVEL SECURITY;
