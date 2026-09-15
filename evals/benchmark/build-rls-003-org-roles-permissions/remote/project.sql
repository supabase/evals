CREATE TABLE memberships (
  user_id uuid NOT NULL,
  org_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  PRIMARY KEY (user_id, org_id)
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL
);

GRANT SELECT ON memberships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO authenticated;

-- Mimics someone accepting Studio's default read-access policy template
-- without customizing it. Permissive policies OR together in Postgres RLS,
-- so this stays a live hole unless the agent notices and drops it.
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable read access for all users" ON documents FOR SELECT USING (true);

INSERT INTO memberships (user_id, org_id, role) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'admin'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'editor'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'viewer'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '22222222-2222-2222-2222-222222222222', 'editor'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '11111111-1111-1111-1111-111111111111', 'viewer'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '22222222-2222-2222-2222-222222222222', 'admin');

INSERT INTO documents (id, org_id, owner_id, title, body) VALUES
  ('10000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Admin plan', 'org A admin document'),
  ('10000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Editor draft', 'org A editor document'),
  ('20000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'Org B draft', 'org B editor document');
