-- Public profile for each account, created automatically on signup. Guarded
-- by row-level security so users can only see and edit their own profile.
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

create policy "users can update their own profile"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Newer Supabase CLIs no longer auto-grant privileges on migration-created
-- tables, so grant them explicitly. RLS scopes the rows.
grant select, update on public.profiles to authenticated;

-- Create the profile row when a user signs up. The display name comes from
-- the signup user metadata; if the app doesn't send one, we fall back to the
-- email local part.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      split_part(new.email, '@', 1)
    )
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
