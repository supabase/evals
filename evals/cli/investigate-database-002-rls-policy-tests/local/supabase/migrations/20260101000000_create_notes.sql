create table public.notes (
  id bigint generated always as identity primary key,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  body text not null default '',
  created_at timestamptz not null default now()
);

alter table public.notes enable row level security;

create policy "Users can view their own notes"
  on public.notes for select
  to authenticated
  using ((select auth.uid()) = owner_id);

create policy "Users can create their own notes"
  on public.notes for insert
  to authenticated
  with check ((select auth.uid()) = owner_id);

create policy "Users can update their own notes"
  on public.notes for update
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

create policy "Users can delete their own notes"
  on public.notes for delete
  to authenticated
  using ((select auth.uid()) = owner_id);

create policy "Enable read access for authenticated users"
  on public.notes for select
  to authenticated
  using (true);
