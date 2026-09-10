-- Broken starting state (probe: security-multiple-permissive-policies).
-- profiles has TWO permissive SELECT policies for `authenticated`. Postgres ORs
-- all permissive policies, so a row is visible if EITHER passes. The admin
-- policy's subquery effectively widens access beyond "own row only".
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Intended policy: own rows only.
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

-- The accidental extra permissive policy that widens SELECT access.
CREATE POLICY "profiles_select_admin" ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() IN (SELECT id FROM public.profiles WHERE handle = 'admin'));

INSERT INTO public.profiles (handle)
VALUES ('admin'), ('alice'), ('bob');
