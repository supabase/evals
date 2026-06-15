CREATE TABLE profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email text NOT NULL,
  full_name text,
  deleted boolean NOT NULL DEFAULT false
);

CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

GRANT SELECT, UPDATE ON profiles TO authenticated;
GRANT SELECT, INSERT ON notes TO authenticated;

CREATE POLICY "users read own profile"
ON profiles
FOR SELECT
TO authenticated
USING (id = auth.uid());

CREATE POLICY "users read own notes"
ON notes
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "users write own notes"
ON notes
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

-- Bug: the app's delete-account flow only soft-deletes the profile row. It
-- never touches the auth user or their sessions, so a "deleted" account can
-- keep signing in and using the app indefinitely.
CREATE FUNCTION public.delete_account() RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE public.profiles SET deleted = true WHERE id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.delete_account() TO authenticated;
