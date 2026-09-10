-- Broken starting state (probe: auth-user-trigger).
-- An AFTER INSERT trigger on auth.users writes to public.signup_log inside
-- the GoTrue signup transaction — any failure rolls back the entire user creation.
CREATE TABLE IF NOT EXISTS public.signup_log (
  user_id    uuid,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.signup_log ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.log_new_signup()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = ''
  AS $$
  BEGIN
    INSERT INTO public.signup_log (user_id) VALUES (NEW.id);
    RETURN NEW;
  END;
  $$;

CREATE TRIGGER chaos_signup_log
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.log_new_signup();
