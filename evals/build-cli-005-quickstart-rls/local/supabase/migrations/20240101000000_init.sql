-- Schema for a small team wiki. Nothing here is locked down yet: no table has
-- RLS enabled, no role has been granted anything, and there are no policies or
-- indexes beyond the primary keys.
--
-- The access we want, once policies are in place:
--
--   documents       Private to owner_id. An owner reads, creates, updates, and
--                   deletes their own rows, and never sees anyone else's.
--                   Signed-out visitors see nothing.
--   teams           Readable by the members of the team.
--   team_members    Membership lookup only. Clients must never be able to read
--                   this table directly, so policies on the other tables have
--                   to reach membership some other way.
--   team_documents  Readable by every member of team_id. The author creates
--                   and edits their own.

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE team_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  author_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
