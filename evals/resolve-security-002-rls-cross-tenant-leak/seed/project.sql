-- gen_random_uuid() is built into Postgres 13+ (and PGlite). No extension needed.
CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  author_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id uuid NOT NULL,
  org_id uuid NOT NULL,
  PRIMARY KEY (user_id, org_id)
);

-- Baseline privileges. The eval measures RLS policy correctness, not whether
-- the agent remembered to GRANT standard table access.
GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO authenticated;
GRANT SELECT ON memberships TO authenticated;

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members can read notes"
ON notes
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM memberships m
    WHERE m.user_id = auth.uid()
  )
);

CREATE POLICY "members can insert notes"
ON notes
FOR INSERT
TO authenticated
WITH CHECK (
  author_id = auth.uid()
  AND EXISTS (
    SELECT 1
    FROM memberships m
    WHERE m.user_id = auth.uid()
      AND m.org_id = notes.org_id
  )
);

CREATE POLICY "authors can update notes"
ON notes
FOR UPDATE
TO authenticated
USING (author_id = auth.uid())
WITH CHECK (
  author_id = auth.uid()
  AND EXISTS (
    SELECT 1
    FROM memberships m
    WHERE m.user_id = auth.uid()
      AND m.org_id = notes.org_id
  )
);

CREATE POLICY "authors can delete notes"
ON notes
FOR DELETE
TO authenticated
USING (author_id = auth.uid());
