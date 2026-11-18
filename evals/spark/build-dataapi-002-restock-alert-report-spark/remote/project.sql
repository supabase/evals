-- Inventory for the restock-alert worker. These tables are backend-only:
-- RLS is enabled with no policies, so client-side (publishable) keys read
-- nothing. Trusted backend code authenticates with the secret key, which
-- bypasses RLS.
--
-- Same schema and seed as the benchmark's build-dataapi-002, except that Spark
-- (SQLite) has no identity columns: `bigint generated always as identity`
-- becomes `integer primary key`, which auto-assigns ids the same way, and the
-- inserts list explicit ids (1..n in the same order, so foreign keys match).
create table public.warehouses (
  id integer primary key,
  name text not null
);

create table public.suppliers (
  id integer primary key,
  name text not null,
  email text not null unique
);

create table public.products (
  id integer primary key,
  name text not null,
  supplier_id bigint not null references public.suppliers (id),
  reorder_threshold int not null
);

create table public.inventory (
  id integer primary key,
  warehouse_id bigint not null references public.warehouses (id),
  product_id bigint not null references public.products (id),
  quantity int not null check (quantity >= 0)
);

alter table public.warehouses enable row level security;
alter table public.suppliers enable row level security;
alter table public.products enable row level security;
alter table public.inventory enable row level security;

-- Newer Supabase CLIs no longer auto-grant privileges on migration-created
-- tables. The trusted backend (secret key → service_role) needs the SELECT
-- privilege; client-side roles get nothing, so these tables stay backend-only.
grant select on public.warehouses, public.suppliers, public.products,
  public.inventory to service_role;

-- Seed data.
insert into public.warehouses (id, name) values
  (1, 'North DC'),
  (2, 'South DC'),
  (3, 'West DC');

insert into public.suppliers (id, name, email) values
  (1, 'Acme Supplies', 'acme@example.com'),
  (2, 'Global Parts', 'parts@example.com');

insert into public.products (id, name, supplier_id, reorder_threshold) values
  (1, 'Widget', 1, 20),
  (2, 'Gadget', 2, 15),
  (3, 'Gizmo', 1, 10);

-- warehouse_id, product_id, quantity. Below-threshold rows are the alerts;
-- West DC's Widget sits exactly at threshold and must NOT alert (strict
-- less-than), and West DC has no Gizmo row at all (untracked combos are
-- simply absent, not a zero-quantity alert).
insert into public.inventory (id, warehouse_id, product_id, quantity) values
  (1, 1, 1, 5),   -- North DC / Widget: 5 < 20 -> alert
  (2, 1, 2, 30),  -- North DC / Gadget: 30 >= 15 -> ok
  (3, 1, 3, 3),   -- North DC / Gizmo: 3 < 10 -> alert
  (4, 2, 1, 25),  -- South DC / Widget: 25 >= 20 -> ok
  (5, 2, 2, 2),   -- South DC / Gadget: 2 < 15 -> alert
  (6, 2, 3, 12),  -- South DC / Gizmo: 12 >= 10 -> ok
  (7, 3, 1, 20),  -- West DC / Widget: 20 >= 20 -> ok (boundary, not strictly below)
  (8, 3, 2, 0);   -- West DC / Gadget: 0 < 15 -> alert
