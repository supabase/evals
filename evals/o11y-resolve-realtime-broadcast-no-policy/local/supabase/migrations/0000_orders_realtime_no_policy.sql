-- Broken starting state (probe: realtime-broadcast-no-policy).
-- orders is in supabase_realtime publication with RLS enabled but no SELECT
-- policy — Realtime broadcasts events to any subscriber regardless of access.
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'orders'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.orders';
  END IF;
END $$;

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "orders_select_authenticated" ON public.orders;
DROP POLICY IF EXISTS "select_own_orders" ON public.orders;
