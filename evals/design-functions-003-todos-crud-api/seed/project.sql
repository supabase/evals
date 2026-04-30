CREATE TABLE todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  body text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO authenticated;

CREATE POLICY "users can read own todos"
ON todos
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "users can insert own todos"
ON todos
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

CREATE POLICY "users can update own todos"
ON todos
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE POLICY "users can delete own todos"
ON todos
FOR DELETE
TO authenticated
USING (user_id = auth.uid());
