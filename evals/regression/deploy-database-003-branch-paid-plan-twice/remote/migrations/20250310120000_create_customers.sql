create table public.customers (
  id bigint generated always as identity primary key,
  email text not null unique,
  full_name text,
  created_at timestamptz not null default now()
);

alter table public.customers enable row level security;
