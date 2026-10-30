-- To-do app. People keep their own todos, and a list can be shared with other
-- people so everyone on it works from the same set of items.

create table todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

create table lists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table list_members (
  list_id uuid not null references lists (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  primary key (list_id, user_id)
);

create table list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references lists (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

-- Weather dashboard. Readings arrive from the station feed every ten minutes
-- and anyone can look at them.

create table weather_stations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  latitude numeric not null,
  longitude numeric not null
);

create table weather_readings (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references weather_stations (id) on delete cascade,
  observed_at timestamptz not null default now(),
  temp_c numeric not null,
  conditions text not null
);

create index todos_user_id_idx on todos (user_id);
create index lists_owner_id_idx on lists (owner_id);
create index list_members_user_id_idx on list_members (user_id);
create index list_items_list_id_idx on list_items (list_id);
create index weather_readings_station_id_idx on weather_readings (station_id);

create schema private;

create function private.is_list_owner(target_list uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.lists
    where id = target_list and owner_id = (select auth.uid())
  );
$$;

create function private.is_list_member(target_list uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.lists
    where id = target_list and owner_id = (select auth.uid())
  ) or exists (
    select 1 from public.list_members
    where list_id = target_list and user_id = (select auth.uid())
  );
$$;

revoke all on function private.is_list_owner(uuid) from public;
revoke all on function private.is_list_member(uuid) from public;
grant usage on schema private to authenticated;
grant execute on function private.is_list_owner(uuid) to authenticated;
grant execute on function private.is_list_member(uuid) to authenticated;

alter table todos enable row level security;
alter table lists enable row level security;
alter table list_members enable row level security;
alter table list_items enable row level security;
alter table weather_stations enable row level security;
alter table weather_readings enable row level security;

revoke all on todos, lists, list_members, list_items from anon;
revoke insert, update, delete, truncate on weather_stations, weather_readings from anon, authenticated;

create policy "todos_select_own" on todos for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "todos_insert_own" on todos for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "todos_update_own" on todos for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "todos_delete_own" on todos for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "lists_select_member" on lists for select to authenticated
  using ((select private.is_list_member(id)));
create policy "lists_insert_owner" on lists for insert to authenticated
  with check ((select auth.uid()) = owner_id);
create policy "lists_update_owner" on lists for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
create policy "lists_delete_owner" on lists for delete to authenticated
  using ((select auth.uid()) = owner_id);

create policy "list_members_select_member" on list_members for select to authenticated
  using ((select private.is_list_member(list_id)));
create policy "list_members_insert_owner" on list_members for insert to authenticated
  with check ((select private.is_list_owner(list_id)));
create policy "list_members_delete_owner_or_self" on list_members for delete to authenticated
  using ((select private.is_list_owner(list_id)) or (select auth.uid()) = user_id);

create policy "list_items_select_member" on list_items for select to authenticated
  using ((select private.is_list_member(list_id)));
create policy "list_items_insert_member" on list_items for insert to authenticated
  with check ((select private.is_list_member(list_id)) and (select auth.uid()) = author_id);
create policy "list_items_update_member" on list_items for update to authenticated
  using ((select private.is_list_member(list_id)))
  with check ((select private.is_list_member(list_id)));
create policy "list_items_delete_member" on list_items for delete to authenticated
  using ((select private.is_list_member(list_id)));

create policy "weather_stations_read" on weather_stations for select to anon, authenticated
  using (true);
create policy "weather_readings_read" on weather_readings for select to anon, authenticated
  using (true);

insert into weather_stations (id, name, latitude, longitude) values
  ('5a1e0000-0000-4000-8000-000000000001', 'Harbour Point', -33.8568, 151.2153),
  ('5a1e0000-0000-4000-8000-000000000002', 'Ridge Top', -33.7000, 150.3000);

insert into weather_readings (station_id, observed_at, temp_c, conditions) values
  ('5a1e0000-0000-4000-8000-000000000001', now() - interval '20 minutes', 21.4, 'clear'),
  ('5a1e0000-0000-4000-8000-000000000001', now() - interval '10 minutes', 21.9, 'clear'),
  ('5a1e0000-0000-4000-8000-000000000002', now() - interval '10 minutes', 14.2, 'fog');
