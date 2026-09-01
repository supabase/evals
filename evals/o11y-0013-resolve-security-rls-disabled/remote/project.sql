-- Broken starting state (probe: security-rls-disabled).
-- profiles is exposed to the API with RLS disabled and SELECT granted to anon,
-- so anon can read every row. The baseline app expects a signed-in user to see
-- only their own profile.
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- RLS is never enabled, and anon is granted read access.
GRANT SELECT ON public.profiles TO anon;

INSERT INTO public.profiles (handle)
VALUES ('alice'), ('bob'), ('carol');
