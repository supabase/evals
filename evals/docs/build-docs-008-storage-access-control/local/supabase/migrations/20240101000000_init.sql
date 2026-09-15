-- Lumen, a reading journal. People sign up, keep private notes on the books
-- they read, and set a profile picture that shows on their own account screen.

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null,
  -- The picture's file name on its own, with no path in front of it. The web
  -- and mobile clients both address the file as '<profiles.id>/<picture_file>'
  -- and neither is changing, so keep that naming.
  picture_file text
);

create table notes (
  id bigint primary key generated always as identity,
  author_id uuid not null references auth.users on delete cascade,
  book_title text not null,
  body text not null,
  created_at timestamptz not null default now()
);

-- The rules for these two tables are settled and the app depends on them as
-- they are. Nothing below concerns the profile pictures.

alter table profiles enable row level security;
alter table notes enable row level security;

create policy "people read their own profile"
on profiles for select to authenticated
using ((select auth.uid()) = id);

create policy "people create their own profile"
on profiles for insert to authenticated
with check ((select auth.uid()) = id);

create policy "people change their own profile"
on profiles for update to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "people read their own notes"
on notes for select to authenticated
using ((select auth.uid()) = author_id);

create policy "people write their own notes"
on notes for insert to authenticated
with check ((select auth.uid()) = author_id);
