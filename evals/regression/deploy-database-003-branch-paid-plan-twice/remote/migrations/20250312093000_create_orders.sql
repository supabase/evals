create table public.orders (
  id bigint generated always as identity primary key,
  customer_id bigint not null references public.customers (id),
  total_cents integer not null check (total_cents >= 0),
  created_at timestamptz not null default now()
);

create index orders_customer_id_idx on public.orders (customer_id);

alter table public.orders enable row level security;
