-- Hosted project state; read once the eval enables hostedProject.

create table public.customers (
  id bigint generated always as identity primary key,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table public.legacy_coupons (
  code text primary key,
  customer_id bigint references public.customers (id),
  percent_off integer not null,
  issued_at timestamptz not null default now(),
  redeemed_at timestamptz
);

insert into public.customers (email) values
  ('customer1@example.com'),
  ('customer2@example.com'),
  ('customer3@example.com'),
  ('customer4@example.com'),
  ('customer5@example.com'),
  ('customer6@example.com'),
  ('customer7@example.com'),
  ('customer8@example.com');

insert into public.legacy_coupons (code, customer_id, percent_off, issued_at, redeemed_at) values
  ('LGCY-7QX2KD', 1, 10, '2026-08-03 09:00:00+00', '2026-08-20 14:12:00+00'),
  ('LGCY-M4T9PV', 1, 15, '2026-08-03 09:00:00+00', null),
  ('LGCY-H2ZR8C', 2, 20, '2026-08-05 11:30:00+00', null),
  ('LGCY-W6NB3J', 2, 25, '2026-08-05 11:30:00+00', '2026-08-28 16:45:00+00'),
  ('LGCY-K9DF5S', 3, 10, '2026-08-09 08:15:00+00', null),
  ('LGCY-P3VY7A', 3, 15, '2026-08-09 08:15:00+00', null),
  ('LGCY-R8LC2E', 4, 20, '2026-08-12 13:00:00+00', '2026-09-01 10:05:00+00'),
  ('LGCY-B5XQ6N', 4, 25, '2026-08-12 13:00:00+00', null),
  ('LGCY-T7JM4G', 5, 10, '2026-08-18 15:40:00+00', null),
  ('LGCY-F2WK9H', 5, 15, '2026-08-18 15:40:00+00', null),
  ('LGCY-N6SD3U', 6, 20, '2026-08-24 10:20:00+00', null),
  ('LGCY-Z4GP8Y', 6, 25, '2026-08-24 10:20:00+00', '2026-09-03 12:30:00+00'),
  ('LGCY-C9RT5M', 7, 10, '2026-08-30 17:05:00+00', null),
  ('LGCY-J3HV7W', 8, 15, '2026-09-02 09:50:00+00', null),
  ('LGCY-Y8BN2F', 8, 20, '2026-09-02 09:50:00+00', null);

create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key,
  statements text[],
  name text
);

insert into supabase_migrations.schema_migrations (version, name, statements) values
  ('20260801000000', 'create_shop', array['create table public.customers (
  id bigint generated always as identity primary key,
  email text not null unique,
  created_at timestamptz not null default now()
);',
  'create table public.legacy_coupons (
  code text primary key,
  customer_id bigint references public.customers (id),
  percent_off integer not null,
  issued_at timestamptz not null default now(),
  redeemed_at timestamptz
);']);
