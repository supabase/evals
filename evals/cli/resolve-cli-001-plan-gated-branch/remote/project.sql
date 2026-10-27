-- Hosted project state; read once the eval enables hostedProject.

create table public.tickets (
  id bigint generated always as identity primary key,
  subject text not null,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

insert into public.tickets (subject)
select 'Ticket ' || n
from generate_series(1, 8) as n;

create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key,
  statements text[],
  name text
);

insert into supabase_migrations.schema_migrations (version, name, statements) values
  ('20260310090000', 'create_tickets', array['create table public.tickets (id bigint generated always as identity primary key, subject text not null, status text not null default ''open'', created_at timestamptz not null default now())']);
