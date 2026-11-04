create table public.profiles (
  id uuid primary key,
  display_name text not null,
  plan text not null default 'free',
  created_at timestamptz not null default now()
);
