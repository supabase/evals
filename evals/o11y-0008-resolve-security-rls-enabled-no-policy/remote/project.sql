-- Broken starting state (probe: health-rls-enabled-no-policy / Splinter lint 0008).
-- public.documents has RLS enabled but no policies. Postgres default-deny means
-- every query returns zero rows for all non-superuser roles — silently, no error.
CREATE TABLE public.documents (
  id      bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  title   text NOT NULL,
  body    text
);
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

INSERT INTO public.documents (user_id, title, body)
SELECT
  CASE WHEN g % 2 = 0
    THEN '00000000-0000-0000-0000-000000000001'
    ELSE '00000000-0000-0000-0000-000000000002'
  END::uuid,
  'doc ' || g,
  'content ' || g
FROM generate_series(1, 50) g;
