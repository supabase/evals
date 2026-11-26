create table public.entries (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create table public.habits (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null
);

alter table public.entries enable row level security;
alter table public.habits enable row level security;

grant select, insert, update, delete on table public.entries to authenticated;
grant select, insert, update, delete on table public.habits to authenticated;

create policy "People keep their own entries"
  on public.entries for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "People keep their own habits"
  on public.habits for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
