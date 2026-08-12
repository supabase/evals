CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX documents_user_id_idx ON documents (user_id);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO authenticated;

-- Bug: the ownership predicate calls auth.uid() directly, so Postgres
-- re-evaluates the function once per row scanned instead of once per query.
-- On a large table this turns every RLS-filtered read into a per-row function
-- call and the query slows down as the table grows. The fix is to wrap the
-- auth call in a scalar subquery -- (select auth.uid()) -- so the planner
-- caches it as an InitPlan and evaluates it a single time.
CREATE POLICY "read own documents"
ON documents
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "insert own documents"
ON documents
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

-- Bulk background rows owned by other users, so the RLS filter has to scan a
-- large table and the per-row auth.uid() re-evaluation is measurable.
INSERT INTO documents (user_id, title, body)
SELECT
  gen_random_uuid(),
  'doc ' || g,
  repeat('lorem ipsum ', 20)
FROM generate_series(1, 20000) AS g;
