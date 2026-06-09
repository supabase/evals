CREATE TABLE private_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE private_notes ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON private_notes TO authenticated;

CREATE POLICY "users can read own private notes"
ON private_notes
FOR SELECT
TO authenticated
USING (user_id = auth.uid());
