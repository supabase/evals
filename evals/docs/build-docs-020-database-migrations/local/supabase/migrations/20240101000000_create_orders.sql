-- Kettle & Crumb sells bread and coffee beans online. One row per order.

create table public.orders (
  id bigint primary key generated always as identity,
  customer text not null,
  total_cents integer not null,
  placed_at timestamptz not null default now()
);
