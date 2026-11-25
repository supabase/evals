create table rooms (
  id bigint primary key generated always as identity,
  name text not null
);

create table room_members (
  room_id bigint not null references rooms on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  primary key (room_id, user_id)
);

create table messages (
  id bigint primary key generated always as identity,
  room_id bigint not null references rooms on delete cascade,
  author_id uuid not null default auth.uid() references auth.users on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create index messages_room_id_created_at_idx on messages (room_id, created_at);

create function public.is_room_member(room bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_members
    where room_id = room
      and user_id = (select auth.uid())
  );
$$;

revoke execute on function public.is_room_member(bigint) from public, anon;
grant execute on function public.is_room_member(bigint) to authenticated;

alter table rooms enable row level security;
alter table room_members enable row level security;
alter table messages enable row level security;

grant select on table rooms to authenticated;
grant select on table room_members to authenticated;
grant select, insert on table messages to authenticated;

create policy "members see their rooms"
on rooms for select to authenticated
using ((select public.is_room_member(id)));

create policy "members see who else is in their rooms"
on room_members for select to authenticated
using ((select public.is_room_member(room_id)));

create policy "members read their rooms"
on messages for select to authenticated
using ((select public.is_room_member(room_id)));

create policy "members post in their rooms as themselves"
on messages for insert to authenticated
with check (
  (select auth.uid()) = author_id
  and (select public.is_room_member(room_id))
);
