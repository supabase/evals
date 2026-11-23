-- The kitchen wanted to see which orders were still open.

alter table public.orders
  add column status text not null default 'placed';
