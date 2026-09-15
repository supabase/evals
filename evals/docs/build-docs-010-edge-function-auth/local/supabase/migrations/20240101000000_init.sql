-- Thistle, a small online shop. Every order belongs to the customer who placed
-- it, and the app only ever shows people their own.

create table public.orders (
  id bigint primary key generated always as identity,
  customer_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  item text not null,
  placed_on date not null default current_date
);

-- Who may read an order is settled and the app depends on it as it is. Both
-- grants are here because current CLI versions no longer add them for you, and
-- without them nothing can read the table at all.

alter table public.orders enable row level security;

create policy "customers read their own orders"
on public.orders for select to authenticated
using ((select auth.uid()) = customer_id);

grant select on public.orders to authenticated, service_role;
