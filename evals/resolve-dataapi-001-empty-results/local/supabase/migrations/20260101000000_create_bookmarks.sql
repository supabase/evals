create table public.bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  title text not null,
  url text not null,
  created_at timestamptz not null default now()
);

alter table public.bookmarks enable row level security;

create policy "Users can view their own bookmarks"
  on public.bookmarks
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert their own bookmarks"
  on public.bookmarks
  for insert
  to authenticated
  with check (auth.uid() = user_id);

insert into public.bookmarks (user_id, title, url)
values
  ('00000000-0000-4000-8000-000000000001', 'seeded alpha', 'https://example.com/alpha'),
  ('00000000-0000-4000-8000-000000000002', 'seeded beta', 'https://example.com/beta');
