-- Hosted project state; read once the eval enables hostedProject.

create table public.orders (
  id bigint generated always as identity primary key,
  customer_email text not null,
  total_cents integer not null check (total_cents >= 0),
  created_at timestamptz not null default now()
);

insert into public.orders (customer_email, total_cents)
select 'customer' || n || '@example.com', 1000 + n * 250
from generate_series(1, 12) as n;

create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key,
  statements text[],
  name text
);

insert into supabase_migrations.schema_migrations (version, name, statements) values
  ('20260301090000', 'create_orders', array['create table public.orders (id bigint generated always as identity primary key, customer_email text not null, total_cents integer not null check (total_cents >= 0), created_at timestamptz not null default now())']);
