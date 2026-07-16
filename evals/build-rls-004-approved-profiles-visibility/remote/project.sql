CREATE TABLE profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  display_name text,
  bio text,
  is_approved boolean NOT NULL DEFAULT false
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Baseline privileges. The eval measures RLS policy correctness, not whether
-- the agent remembered to GRANT standard table access.
GRANT SELECT, INSERT, UPDATE, DELETE ON profiles TO authenticated;
