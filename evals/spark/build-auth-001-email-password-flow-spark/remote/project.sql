-- Public profile for each account, created by the app right after signup.
-- Guarded by row-level security so users can only see, add and edit their own
-- profile.
--
-- Same schema as the benchmark's build-auth-001, except that Spark has no
-- plpgsql functions or triggers on auth.users: the `handle_new_user` function
-- and `on_auth_user_created` trigger are removed, so the app creates the
-- profile itself, which needs an insert policy and grant.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  plan text not null default 'free',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "users can read their own profile"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = id);

create policy "users can insert their own profile"
  on public.profiles
  for insert
  to authenticated
  with check (auth.uid() = id);

create policy "users can update their own profile"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Grant privileges explicitly; RLS scopes the rows.
grant select, insert, update on public.profiles to authenticated;
