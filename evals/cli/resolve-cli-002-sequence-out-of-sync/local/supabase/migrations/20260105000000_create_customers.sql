create table public.customers (
  id serial primary key,
  name text not null,
  email text not null unique,
  created_at timestamptz not null default now()
);
