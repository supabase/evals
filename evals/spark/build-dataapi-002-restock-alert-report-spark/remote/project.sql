-- Inventory for the restock alert. West DC's Widget sits exactly at its
-- threshold and must not alert, and West DC has no Gizmo row at all.
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
  supplier_id integer not null references public.suppliers (id),
  reorder_threshold integer not null
);

create table public.inventory (
  id integer primary key,
  warehouse_id integer not null references public.warehouses (id),
  product_id integer not null references public.products (id),
  quantity integer not null check (quantity >= 0)
);

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

insert into public.inventory (id, warehouse_id, product_id, quantity) values
  (1, 1, 1, 5),   -- North DC / Widget: 5 < 20, alert
  (2, 1, 2, 30),  -- North DC / Gadget: ok
  (3, 1, 3, 3),   -- North DC / Gizmo: 3 < 10, alert
  (4, 2, 1, 25),  -- South DC / Widget: ok
  (5, 2, 2, 2),   -- South DC / Gadget: 2 < 15, alert
  (6, 2, 3, 12),  -- South DC / Gizmo: ok
  (7, 3, 1, 20),  -- West DC / Widget: exactly at threshold, no alert
  (8, 3, 2, 0);   -- West DC / Gadget: 0 < 15, alert
