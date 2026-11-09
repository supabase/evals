-- Order history for the sales report. Alan has no orders and must not appear
-- in the report.
create table public.customers (
  id integer primary key,
  name text not null,
  email text not null unique
);

create table public.products (
  id integer primary key,
  name text not null,
  price_cents integer not null
);

create table public.orders (
  id integer primary key,
  customer_id integer not null references public.customers (id),
  ordered_at timestamptz not null default now()
);

create table public.order_items (
  id integer primary key,
  order_id integer not null references public.orders (id),
  product_id integer not null references public.products (id),
  quantity integer not null check (quantity > 0)
);

insert into public.customers (id, name, email) values
  (1, 'Ada Lovelace', 'ada@example.com'),
  (2, 'Grace Hopper', 'grace@example.com'),
  (3, 'Linus Pauling', 'linus@example.com'),
  (4, 'Alan Turing', 'alan@example.com');

insert into public.products (id, name, price_cents) values
  (1, 'Keyboard', 4500),
  (2, 'Mouse', 2500),
  (3, 'Monitor', 32000),
  (4, 'Cable', 900);

insert into public.orders (id, customer_id, ordered_at) values
  (1, 1, '2026-06-01T10:00:00Z'),
  (2, 1, '2026-06-14T09:30:00Z'),
  (3, 2, '2026-06-03T16:20:00Z'),
  (4, 2, '2026-06-20T11:05:00Z'),
  (5, 3, '2026-06-08T14:45:00Z');

insert into public.order_items (id, order_id, product_id, quantity) values
  (1, 1, 1, 2), -- Ada: 2x Keyboard
  (2, 1, 4, 1), -- Ada: 1x Cable
  (3, 2, 3, 1), -- Ada: 1x Monitor
  (4, 3, 2, 3), -- Grace: 3x Mouse
  (5, 4, 1, 1), -- Grace: 1x Keyboard
  (6, 4, 4, 4), -- Grace: 4x Cable
  (7, 5, 3, 2), -- Linus: 2x Monitor
  (8, 5, 2, 1); -- Linus: 1x Mouse
