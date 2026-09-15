-- Fernwood, a hobby forum. Members write posts about their projects. A few of
-- them are moderators, and the admin tooling already records that in
-- member_roles, so treat that table as the list of who is one.

create type public.forum_role as enum ('moderator');

create table posts (
  id bigint primary key generated always as identity,
  author_id uuid not null references auth.users on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create table member_roles (
  member_id uuid not null references auth.users on delete cascade,
  role forum_role not null,
  primary key (member_id, role)
);

-- Reading posts and writing your own are settled, and the app depends on both
-- as they are. The delete grant is here so the forum can offer the button at
-- all. Nothing below decides who may use it.

alter table posts enable row level security;
alter table member_roles enable row level security;

grant select, insert, delete on table posts to authenticated;

create policy "members read every post"
on posts for select to authenticated
using (true);

create policy "members write their own posts"
on posts for insert to authenticated
with check ((select auth.uid()) = author_id);
