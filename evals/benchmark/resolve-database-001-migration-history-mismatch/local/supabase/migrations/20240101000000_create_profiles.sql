create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  username text not null unique
);
