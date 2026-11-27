create table public.orders (
  id serial primary key,
  item text not null,
  created_at timestamptz not null default now()
);
