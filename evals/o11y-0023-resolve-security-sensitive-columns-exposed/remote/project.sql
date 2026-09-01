-- Broken starting state (probe: security-sensitive-columns-exposed / Splinter lint 0023).
-- public.api_keys has columns named 'password' and 'secret' with RLS disabled,
-- so any authenticated user can read all API credentials via the Data API.
CREATE TABLE public.api_keys (
  id       bigserial PRIMARY KEY,
  user_id  uuid NOT NULL,
  name     text NOT NULL,
  password text NOT NULL,
  secret   text NOT NULL,
  created_at timestamptz DEFAULT now()
);

GRANT SELECT ON public.api_keys TO authenticated;

INSERT INTO public.api_keys (user_id, name, password, secret)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'prod-key', 'hunter2', 'sk-real-secret-abc123'),
  ('00000000-0000-0000-0000-000000000002', 'dev-key',  'qwerty',  'sk-real-secret-def456');
