CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  title text NOT NULL,
  is_done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON tasks TO authenticated;

CREATE POLICY "read own tasks"
ON tasks
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "insert own tasks"
ON tasks
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

-- Bug: this UPDATE policy only has WITH CHECK, no USING, so Postgres finds no
-- existing row to update and the statement silently affects 0 rows.
CREATE POLICY "update own tasks"
ON tasks
FOR UPDATE
TO authenticated
WITH CHECK (user_id = auth.uid());
