-- A small app with tables in two schemas. `public` holds the user-facing
-- tables; `billing` holds payment data and is granted to `authenticated`, so
-- a table there without RLS is readable by every signed-in user.
--
-- Ground truth for the audit (tables WITHOUT row level security):
--   public.support_tickets
--   billing.invoices
--   billing.payment_methods
-- Everything else has RLS enabled with a policy.

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  display_name text NOT NULL
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile" ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid());

CREATE TABLE public.posts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author_id uuid NOT NULL REFERENCES public.profiles (id),
  body text NOT NULL
);
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read posts" ON public.posts FOR SELECT TO authenticated
  USING (true);

-- Missing RLS, in the default schema.
CREATE TABLE public.support_tickets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles (id),
  subject text NOT NULL
);

CREATE SCHEMA billing;
GRANT USAGE ON SCHEMA billing TO authenticated;

CREATE TABLE billing.plans (
  id text PRIMARY KEY,
  monthly_price_cents integer NOT NULL
);
ALTER TABLE billing.plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read plans" ON billing.plans FOR SELECT TO authenticated
  USING (true);

-- Missing RLS, outside `public`. list_tables only returns these when the
-- caller passes the schema explicitly (supabase/mcp#395).
CREATE TABLE billing.invoices (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles (id),
  plan_id text NOT NULL REFERENCES billing.plans (id),
  amount_cents integer NOT NULL
);

CREATE TABLE billing.payment_methods (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles (id),
  card_last4 text NOT NULL,
  stripe_customer_id text NOT NULL
);

GRANT SELECT ON ALL TABLES IN SCHEMA billing TO authenticated;

INSERT INTO public.profiles (id, display_name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'Bob');
INSERT INTO billing.plans (id, monthly_price_cents) VALUES
  ('starter', 900), ('pro', 2900);
INSERT INTO billing.invoices (user_id, plan_id, amount_cents) VALUES
  ('11111111-1111-1111-1111-111111111111', 'pro', 2900),
  ('22222222-2222-2222-2222-222222222222', 'starter', 900);
INSERT INTO billing.payment_methods (user_id, card_last4, stripe_customer_id) VALUES
  ('11111111-1111-1111-1111-111111111111', '4242', 'cus_alice'),
  ('22222222-2222-2222-2222-222222222222', '1881', 'cus_bob');
INSERT INTO public.support_tickets (user_id, subject) VALUES
  ('22222222-2222-2222-2222-222222222222', 'Card declined on renewal');
