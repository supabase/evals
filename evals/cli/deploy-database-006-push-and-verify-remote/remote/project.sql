-- Hosted project state; read once the eval enables hostedProject.

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  is_paid boolean not null default false,
  created_at timestamptz not null default now()
);

insert into public.profiles (username, is_paid)
select 'user_' || n, n % 4 = 0
from generate_series(1, 24) as n;

create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key,
  statements text[],
  name text
);

insert into supabase_migrations.schema_migrations (version, name, statements) values
  ('20260901000000', 'create_profiles', array['create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  is_paid boolean not null default false,
  created_at timestamptz not null default now()
)']);
