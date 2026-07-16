CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

INSERT INTO companies (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Acme Corp'),
  ('22222222-2222-2222-2222-222222222222', 'Globex Inc');

CREATE TABLE profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies(id),
  display_name text,
  bio text,
  is_approved boolean NOT NULL DEFAULT false
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON companies TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON profiles TO authenticated;
