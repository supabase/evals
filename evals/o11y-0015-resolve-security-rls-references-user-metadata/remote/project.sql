-- Broken starting state (probe: security-rls-references-user-metadata / Splinter lint 0015).
-- customers has an RLS policy that grants SELECT based on user_metadata.role = 'admin'.
-- user_metadata is user-editable — any authenticated user can self-promote.
CREATE TABLE public.customers (
  id serial PRIMARY KEY,
  email text UNIQUE NOT NULL
);

INSERT INTO public.customers (email)
SELECT 'customer' || g || '@example.com' FROM generate_series(1, 50) AS g;

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customers_metadata_role" ON public.customers
  FOR SELECT TO authenticated
  USING (((auth.jwt() ->> 'user_metadata')::jsonb ->> 'role') = 'admin');
