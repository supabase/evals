-- Starting state (probe: postgres-auth-admin-bypassrls).
-- HARNESS NOTE: PGlite does not support CREATE ROLE or BYPASSRLS.
-- Simulates a SECURITY DEFINER function accessible to public roles that
-- bypasses row-level security (runs as owner, not caller).
CREATE TABLE public.orders (
  id bigserial PRIMARY KEY,
  total_cents int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

INSERT INTO public.orders (total_cents)
SELECT (g * 100)
FROM generate_series(1, 50) g;

-- Callable by any authenticated or anonymous user, but runs as function owner —
-- bypassing the RLS on public.orders entirely.
CREATE OR REPLACE FUNCTION public.get_all_orders()
  RETURNS SETOF public.orders
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT * FROM public.orders;
$$;

GRANT EXECUTE ON FUNCTION public.get_all_orders() TO authenticated, anon;
