-- Broken starting state (probe: security-rls-initplan / Splinter lint 0003).
-- profiles RLS policy calls auth.uid() via a VOLATILE wrapper function,
-- forcing per-row re-evaluation (subplan) instead of the efficient single
-- initplan Postgres uses for the built-in directly.
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.current_user_id()
  RETURNS uuid LANGUAGE sql VOLATILE
  AS $$ SELECT auth.uid() $$;

CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT TO authenticated
  USING (id = public.current_user_id());

INSERT INTO public.profiles (handle)
SELECT 'user_' || g FROM generate_series(1, 100) g;
