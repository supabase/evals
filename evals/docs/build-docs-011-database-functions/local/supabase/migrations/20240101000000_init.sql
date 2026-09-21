-- Marlow, an online shop. The web app and the mobile app each work out an
-- order's total on their own, and the two have drifted apart.

create table public.orders (
  id bigint primary key generated always as identity,
  customer_id uuid not null references auth.users on delete cascade default auth.uid(),
  -- The rate finance applies to this order, in basis points. 825 is 8.25%.
  tax_rate_bps int not null default 825,
  placed_on date not null default current_date
);

create table public.order_items (
  id bigint primary key generated always as identity,
  order_id bigint not null references public.orders on delete cascade,
  description text not null,
  unit_price_cents int not null,
  quantity int not null
);

-- Who may read an order is settled and both apps depend on it as it is.
-- Both grants are here because current CLI versions no longer add them.

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

grant select on public.orders, public.order_items to authenticated;

create policy "customers read their own orders"
on public.orders for select to authenticated
using ((select auth.uid()) = customer_id);

create policy "customers read their own order items"
on public.order_items for select to authenticated
using (
  exists (
    select 1 from public.orders o
    where o.id = order_items.order_id
      and o.customer_id = (select auth.uid())
  )
);
