create table public.customers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  full_name text not null,
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id),
  total_cents integer not null check (total_cents > 0),
  created_at timestamptz not null default now()
);

create index orders_customer_id_idx on public.orders (customer_id);

alter table public.customers enable row level security;
alter table public.orders enable row level security;
