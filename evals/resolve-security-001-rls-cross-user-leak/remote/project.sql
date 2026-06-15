CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  body text NOT NULL,
  is_pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON notes TO authenticated;

-- Bug: every authenticated user can read every note.
CREATE POLICY "read notes"
ON notes
FOR SELECT
TO authenticated
USING (auth.uid() IS NOT NULL);

-- Bug: missing WITH CHECK lets a user reassign their note to another user.
CREATE POLICY "update own notes"
ON notes
FOR UPDATE
TO authenticated
USING (user_id = auth.uid());
