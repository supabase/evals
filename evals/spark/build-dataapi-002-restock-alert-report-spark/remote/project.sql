create table public.warehouses (
  id bigserial primary key,
  name text not null
);

create table public.suppliers (
  id bigserial primary key,
  name text not null,
  email text not null unique
);

create table public.products (
  id bigserial primary key,
  name text not null,
  supplier_id bigint not null references public.suppliers (id),
  reorder_threshold int not null
);

create table public.inventory (
  id bigserial primary key,
  warehouse_id bigint not null references public.warehouses (id),
  product_id bigint not null references public.products (id),
  quantity int not null check (quantity >= 0)
);

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
