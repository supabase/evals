-- Broken starting state (probe: security-auth-users-exposed / Splinter lint 0002).
-- public.user_list is a view over auth.users that exposes user PII (email,
-- created_at) to any role with access to the public schema via the Data API.
CREATE OR REPLACE VIEW public.user_list AS
  SELECT id, email, created_at FROM auth.users;

GRANT SELECT ON public.user_list TO anon, authenticated;
