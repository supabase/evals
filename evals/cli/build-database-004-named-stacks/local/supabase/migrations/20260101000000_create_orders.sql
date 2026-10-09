create table public.orders (
  id bigint generated always as identity primary key,
  customer text not null,
  item text not null,
  quantity integer not null default 1 check (quantity > 0),
  created_at timestamptz not null default now()
);
