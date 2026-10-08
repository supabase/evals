create type public.order_status as enum ('pending', 'paid', 'shipped', 'cancelled');

alter table public.orders
  add column status public.order_status not null default 'pending';
