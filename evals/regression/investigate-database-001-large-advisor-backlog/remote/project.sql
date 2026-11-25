-- A large, long-lived project shaped like the Mockamaster capture in
-- supabase/mcp#546: the advisors return 547 findings across 11 lint types.
-- Three are critical and they share one cause: public.payments has RLS
-- disabled, so anyone holding the anon key can read and write every payment
-- row. Its policy is never enforced, and a view over it is reachable through
-- the API too. The rest is real but routine performance and hygiene debt,
-- and it is the bulk of the output, which is what made get_issues overflow
-- before supabase/mcp#546.

CREATE TABLE public.orgs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL
);
ALTER TABLE public.orgs ENABLE ROW LEVEL SECURITY;
CREATE POLICY orgs_read ON public.orgs FOR SELECT TO authenticated USING (true);

-- The critical cause: RLS disabled on payments (rls_disabled_in_public, ERROR).
CREATE TABLE public.payments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL REFERENCES public.orgs (id),
  stripe_customer_id text NOT NULL,
  amount_cents integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_org_id_idx ON public.payments (org_id);

-- Someone wrote a policy but never enabled RLS, so it does nothing
--   -> policy_exists_rls_disabled (ERROR)
CREATE POLICY payments_org_read ON public.payments FOR SELECT TO authenticated
  USING (org_id IN (SELECT id FROM public.orgs));

-- A billing summary view over payments, without security_invoker
--   -> security_definer_view (ERROR)
CREATE VIEW public.payments_by_org AS
  SELECT org_id, sum(amount_cents) AS total_cents, count(*) AS n
  FROM public.payments GROUP BY org_id;

INSERT INTO public.orgs (name)
SELECT 'org-' || n FROM generate_series(1, 25) AS n;

INSERT INTO public.payments (org_id, stripe_customer_id, amount_cents, status)
SELECT ((n - 1) % 25) + 1, 'cus_' || lpad(n::text, 10, '0'), 500 + n * 37 % 9000,
  (ARRAY['pending', 'succeeded', 'refunded'])[1 + n % 3]
FROM generate_series(1, 200) AS n;

-- 80 feature tables. Each one carries:
--   2 unindexed foreign keys            -> 160 unindexed_foreign_keys (INFO)
--   2 policies calling auth.uid() bare  -> 160 auth_rls_initplan (WARN)
--   2 permissive SELECT policies        ->  80 multiple_permissive_policies (WARN)
-- and the first 20 have a duplicated created_at index -> 20 duplicate_index (WARN)
DO $$
DECLARE
  i int;
  t text;
BEGIN
  FOR i IN 1..80 LOOP
    t := format('feature_%s', lpad(i::text, 2, '0'));
    EXECUTE format(
      'CREATE TABLE public.%I (
         id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         org_id bigint NOT NULL REFERENCES public.orgs (id),
         billing_org_id bigint REFERENCES public.orgs (id),
         owner_id uuid NOT NULL,
         payload jsonb NOT NULL DEFAULT ''{}''::jsonb,
         created_at timestamptz NOT NULL DEFAULT now()
       )', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (owner_id = auth.uid())',
      t || '_owner_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL AND org_id IN (SELECT id FROM public.orgs))',
      t || '_member_read', t);
    IF i <= 20 THEN
      EXECUTE format('CREATE INDEX %I ON public.%I (created_at)', t || '_created_at_idx', t);
      EXECUTE format('CREATE INDEX %I ON public.%I (created_at)', t || '_created_idx', t);
    END IF;
  END LOOP;
END
$$;

-- 81 helper functions without a pinned search_path -> 81 function_search_path_mutable (WARN)
DO $$
DECLARE
  i int;
BEGIN
  FOR i IN 1..81 LOOP
    EXECUTE format(
      'CREATE FUNCTION public.%I(x bigint) RETURNS bigint LANGUAGE sql STABLE AS ''SELECT x''',
      format('helper_%s', lpad(i::text, 2, '0')));
  END LOOP;
END
$$;

-- 30 audit tables, RLS on and no policies (deliberately locked down)
--   -> 30 rls_enabled_no_policy (INFO)
-- the last 10 are append-only logs without a primary key -> 10 no_primary_key (INFO)
DO $$
DECLARE
  i int;
  t text;
BEGIN
  FOR i IN 1..30 LOOP
    t := format('audit_%s', lpad(i::text, 2, '0'));
    IF i <= 20 THEN
      EXECUTE format(
        'CREATE TABLE public.%I (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event text NOT NULL, at timestamptz NOT NULL DEFAULT now())', t);
    ELSE
      EXECUTE format(
        'CREATE TABLE public.%I (event text NOT NULL, at timestamptz NOT NULL DEFAULT now())', t);
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- 3 reporting materialized views in the API schema -> 3 materialized_view_in_api (WARN)
CREATE MATERIALIZED VIEW public.daily_feature_usage AS
  SELECT date_trunc('day', created_at) AS day, count(*) AS n FROM public.feature_01 GROUP BY 1;
CREATE MATERIALIZED VIEW public.weekly_feature_usage AS
  SELECT date_trunc('week', created_at) AS week, count(*) AS n FROM public.feature_02 GROUP BY 1;
CREATE MATERIALIZED VIEW public.org_feature_counts AS
  SELECT org_id, count(*) AS n FROM public.feature_03 GROUP BY 1;
