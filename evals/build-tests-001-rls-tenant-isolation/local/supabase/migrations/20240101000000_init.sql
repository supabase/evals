-- Adds memberships, notes, and posts tables.
-- RLS policies on notes and posts enforce org-level tenant isolation:
-- members can only access rows that belong to their organization.

-- Shared membership table: user <-> org association
CREATE TABLE memberships (
  user_id uuid NOT NULL,
  org_id uuid NOT NULL,
  PRIMARY KEY (user_id, org_id)
);

GRANT SELECT ON memberships TO authenticated;

-- notes: org-level tenant isolation
CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  author_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO authenticated;

CREATE POLICY "members can read org notes"
ON notes FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.user_id = auth.uid()
      AND m.org_id = notes.org_id
  )
);

-- posts: org-level tenant isolation
CREATE TABLE posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  author_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON posts TO authenticated;

CREATE POLICY "members can read posts"
ON posts FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.user_id = auth.uid()
  )
);
