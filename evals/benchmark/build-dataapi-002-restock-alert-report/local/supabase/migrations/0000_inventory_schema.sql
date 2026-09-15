-- Inventory for the restock-alert worker. These tables are backend-only:
-- RLS is enabled with no policies, so client-side (publishable) keys read
-- nothing. Trusted backend code authenticates with the secret key, which
-- bypasses RLS.
create table public.warehouses (
  id bigint generated always as identity primary key,
  name text not null
);

create table public.suppliers (
  id bigint generated always as identity primary key,
  name text not null,
  email text not null unique
);

create table public.products (
  id bigint generated always as identity primary key,
  name text not null,
  supplier_id bigint not null references public.suppliers (id),
  reorder_threshold int not null
);

create table public.inventory (
  id bigint generated always as identity primary key,
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
insert into public.warehouses (name) values
  ('North DC'),
  ('South DC'),
  ('West DC');

insert into public.suppliers (name, email) values
  ('Acme Supplies', 'acme@example.com'),
  ('Global Parts', 'parts@example.com');

insert into public.products (name, supplier_id, reorder_threshold) values
  ('Widget', 1, 20),
  ('Gadget', 2, 15),
  ('Gizmo', 1, 10);

-- warehouse_id, product_id, quantity. Below-threshold rows are the alerts;
-- West DC's Widget sits exactly at threshold and must NOT alert (strict
-- less-than), and West DC has no Gizmo row at all (untracked combos are
-- simply absent, not a zero-quantity alert).
insert into public.inventory (warehouse_id, product_id, quantity) values
  (1, 1, 5),   -- North DC / Widget: 5 < 20 -> alert
  (1, 2, 30),  -- North DC / Gadget: 30 >= 15 -> ok
  (1, 3, 3),   -- North DC / Gizmo: 3 < 10 -> alert
  (2, 1, 25),  -- South DC / Widget: 25 >= 20 -> ok
  (2, 2, 2),   -- South DC / Gadget: 2 < 15 -> alert
  (2, 3, 12),  -- South DC / Gizmo: 12 >= 10 -> ok
  (3, 1, 20),  -- West DC / Widget: 20 >= 20 -> ok (boundary, not strictly below)
  (3, 2, 0);   -- West DC / Gadget: 0 < 15 -> alert
