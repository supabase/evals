CREATE TABLE rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON rooms TO authenticated;
GRANT SELECT, INSERT ON messages TO authenticated;

CREATE POLICY "authenticated can read rooms"
ON rooms
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "authenticated can read messages"
ON messages
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "authenticated can insert messages"
ON messages
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

CREATE PUBLICATION supabase_realtime;

INSERT INTO rooms (id, name)
VALUES ('11111111-1111-1111-1111-111111111111', 'general');
