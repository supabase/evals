-- Blog posts. Published posts are public (readable with the client key);
-- drafts are only reachable by trusted backend code that bypasses RLS.
create table public.posts (
  id bigint generated always as identity primary key,
  title text not null,
  published boolean not null default false
);

alter table public.posts enable row level security;

create policy "anyone can read published posts"
  on public.posts
  for select
  to anon, authenticated
  using (published);

-- Newer Supabase CLIs no longer auto-grant privileges on migration-created
-- tables, so grant them explicitly. RLS scopes the rows for client roles;
-- service_role (trusted backend) bypasses RLS but still needs the privilege.
grant select on public.posts to anon, authenticated, service_role;

insert into public.posts (title, published) values
  ('Announcing vector buckets', true),
  ('Realtime broadcast tips', true),
  ('Row level security explained', true),
  ('DRAFT: pricing update', false),
  ('DRAFT: roadmap 2027', false);
