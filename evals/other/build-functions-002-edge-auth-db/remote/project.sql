CREATE TABLE todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON todos TO authenticated;

CREATE POLICY "users can insert their own todos"
ON todos
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

CREATE POLICY "users can read their own todos"
ON todos
FOR SELECT
TO authenticated
USING (user_id = auth.uid());
