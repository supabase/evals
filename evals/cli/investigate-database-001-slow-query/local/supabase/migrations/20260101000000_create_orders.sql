create table public.orders (
  id bigint generated always as identity primary key,
  customer_email text not null,
  status text not null default 'pending',
  total_cents integer not null,
  created_at timestamptz not null default now()
);
