CREATE TABLE todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  body text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Baseline privileges. The eval measures RLS policy correctness, not whether
-- the agent remembered to GRANT standard table access.
GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO authenticated;
