-- Hosted project state; read once the eval enables hostedProject.

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  bio text,
  created_at timestamptz not null default now()
);

insert into public.profiles (username, bio)
select 'user_' || n, 'Bio for user_' || n
from generate_series(1, 25) as n;

create table public.posts (
  id bigint generated always as identity primary key,
  author_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  body text,
  created_at timestamptz not null default now()
);

insert into public.posts (author_id, title)
select (select id from public.profiles where username = 'user_' || ((n - 1) % 25 + 1)), 'Post ' || n
from generate_series(1, 40) as n;

create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key,
  statements text[],
  name text
);

insert into supabase_migrations.schema_migrations (version, name, statements) values
  ('20240101000000', 'create_profiles', array['create table public.profiles (id uuid primary key default gen_random_uuid(), username text not null unique, created_at timestamptz not null default now())']),
  ('20240115093000', 'add_profile_bio', array['alter table public.profiles add column bio text']),
  ('20240201000000', 'create_posts', array['create table public.posts (id bigint generated always as identity primary key, author_id uuid not null references public.profiles (id) on delete cascade, title text not null, body text, created_at timestamptz not null default now())']);
