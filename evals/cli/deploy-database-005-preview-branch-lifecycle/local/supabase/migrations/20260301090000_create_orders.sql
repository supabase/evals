create table public.orders (
  id bigint generated always as identity primary key,
  customer_email text not null,
  total_cents integer not null check (total_cents >= 0),
  created_at timestamptz not null default now()
);
