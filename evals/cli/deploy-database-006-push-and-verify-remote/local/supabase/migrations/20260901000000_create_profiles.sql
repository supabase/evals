create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  is_paid boolean not null default false,
  created_at timestamptz not null default now()
);
