-- Tidewater's orders. The warehouse picks from the fulfilment service
-- (app/receiver.mjs), which has to hear about every order placed and every
-- status change. Customers are here too, but the service has no use for them.
create table public.customers (
  id bigint generated always as identity primary key,
  name text not null,
  email text not null
);

create table public.orders (
  id bigint generated always as identity primary key,
  customer text not null,
  item text not null,
  status text not null default 'placed'
);
