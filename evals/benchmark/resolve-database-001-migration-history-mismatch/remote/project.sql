-- Seeds the hosted ("remote") database for the migration-history-mismatch
-- scenario. This is the production state the agent must reconcile against
-- WITHOUT losing data.
--
-- The remote is ahead of local in a way that breaks `supabase db push`:
-- migration 20240115000000 (the `bio` column) was applied directly on the
-- hosted DB and recorded in the remote history, but was never committed as a
-- local migration file. `db push` sees a remote-only version and refuses to
-- proceed with "the remote database's migration history does not match local
-- files", pointing the user at `supabase migration repair`.

-- Production schema, as it actually exists on the hosted project: the original
-- profiles table (20240101000000) plus the out-of-band `bio` column
-- (20240115000000).
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  bio text
);

-- Real user data that must survive the reconciliation.
insert into public.profiles (username, bio)
select 'user_' || n, 'hello from user ' || n
from generate_series(1, 25) as n;

-- The remote migration history. The CLI tracks applied migrations here; note
-- that 20240115000000 has no matching file in supabase/migrations locally.
create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key,
  statements text[],
  name text
);

insert into supabase_migrations.schema_migrations (version, name) values
  ('20240101000000', 'create_profiles'),
  ('20240115000000', 'add_profile_bio');
