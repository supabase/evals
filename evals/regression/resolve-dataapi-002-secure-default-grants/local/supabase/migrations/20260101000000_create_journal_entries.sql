create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.journal_entries enable row level security;

create policy "Users can view their own journal entries"
  on public.journal_entries
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert their own journal entries"
  on public.journal_entries
  for insert
  to authenticated
  with check (auth.uid() = user_id);

insert into public.journal_entries (user_id, title, body)
values
  ('00000000-0000-4000-8000-000000000001', 'seeded reflection', 'A seeded entry for the first user.'),
  ('00000000-0000-4000-8000-000000000002', 'seeded plans', 'A seeded entry for the second user.');
