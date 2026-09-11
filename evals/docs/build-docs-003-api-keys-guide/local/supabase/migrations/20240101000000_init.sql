-- People pick a display name when they sign up. Emails are not copied here.
-- They stay in auth.users, which is where the roster screen has to read them
-- from.

CREATE TABLE profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "display names are public" ON profiles
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "people write their own profile" ON profiles
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = id);

-- Granted here on purpose. Recent CLI versions hand new tables no DML at all,
-- and working out grants is a different scenario from working out which key
-- goes where.
GRANT SELECT ON profiles TO anon, authenticated;
GRANT INSERT ON profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON profiles TO service_role;
