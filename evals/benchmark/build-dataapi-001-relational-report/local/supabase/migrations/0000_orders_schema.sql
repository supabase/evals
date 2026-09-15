-- Order history for the reporting worker. These tables are backend-only:
-- RLS is enabled with no policies, so client-side (publishable) keys read
-- nothing. Trusted backend code authenticates with the secret key, which
-- bypasses RLS.
create table public.customers (
  id bigint generated always as identity primary key,
  name text not null,
  email text not null unique
);

create table public.products (
  id bigint generated always as identity primary key,
  name text not null,
  price_cents int not null
);

create table public.orders (
  id bigint generated always as identity primary key,
  customer_id bigint not null references public.customers (id),
  ordered_at timestamptz not null default now()
);

create table public.order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders (id),
  product_id bigint not null references public.products (id),
  quantity int not null check (quantity > 0)
);

alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- Newer Supabase CLIs no longer auto-grant privileges on migration-created
-- tables. The trusted backend (secret key → service_role) needs the SELECT
-- privilege; client-side roles get nothing, so these tables stay backend-only.
grant select on public.customers, public.products, public.orders,
  public.order_items to service_role;

-- Seed data. Alan has no orders and must not appear in the report.
insert into public.customers (name, email) values
  ('Ada Lovelace', 'ada@example.com'),
  ('Grace Hopper', 'grace@example.com'),
  ('Linus Pauling', 'linus@example.com'),
  ('Alan Turing', 'alan@example.com');

insert into public.products (name, price_cents) values
  ('Keyboard', 4500),
  ('Mouse', 2500),
  ('Monitor', 32000),
  ('Cable', 900);

insert into public.orders (customer_id, ordered_at) values
  (1, '2026-06-01T10:00:00Z'),
  (1, '2026-06-14T09:30:00Z'),
  (2, '2026-06-03T16:20:00Z'),
  (2, '2026-06-20T11:05:00Z'),
  (3, '2026-06-08T14:45:00Z');

insert into public.order_items (order_id, product_id, quantity) values
  (1, 1, 2), -- Ada: 2x Keyboard
  (1, 4, 1), -- Ada: 1x Cable
  (2, 3, 1), -- Ada: 1x Monitor
  (3, 2, 3), -- Grace: 3x Mouse
  (4, 1, 1), -- Grace: 1x Keyboard
  (4, 4, 4), -- Grace: 4x Cable
  (5, 3, 2), -- Linus: 2x Monitor
  (5, 2, 1); -- Linus: 1x Mouse
