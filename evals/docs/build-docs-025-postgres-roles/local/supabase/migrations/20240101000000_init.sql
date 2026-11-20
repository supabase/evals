-- Brewline, a coffee subscription shop. Customers order beans on a schedule.
-- Finance reads sales numbers; HR keeps what each person on staff is paid.
-- Shoppers never touch these tables directly, and the backend is the only
-- thing that writes them.

create table public.customers (
  id bigint primary key generated always as identity,
  name text not null,
  email text not null
);

create table public.orders (
  id bigint primary key generated always as identity,
  customer_id bigint not null references public.customers,
  reference text not null unique,
  total_cents integer not null,
  placed_at timestamptz not null default now()
);

-- What each person on staff is paid. Finance reports on sales, never on this.
create table public.payroll (
  id bigint primary key generated always as identity,
  employee text not null,
  annual_pay_cents integer not null
);

alter table public.customers enable row level security;
alter table public.orders enable row level security;
alter table public.payroll enable row level security;

insert into public.customers (name, email) values
  ('Ines Calloway', 'ines@example.test'),
  ('Tomasz Reyes', 'tomasz@example.test');

insert into public.orders (customer_id, reference, total_cents) values
  (1, 'BL-1001', 3600),
  (1, 'BL-1002', 1800),
  (2, 'BL-1003', 5400);

insert into public.payroll (employee, annual_pay_cents) values
  ('Mara Okafor', 6800000),
  ('Dev Patel', 5900000);
