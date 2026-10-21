-- An order can ship in several parcels, each with its own carrier and
-- tracking number. A tracking number is only unique within its carrier.
create table public.shipments (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders (id) on delete cascade,
  carrier text not null,
  tracking_number text not null,
  shipped_at timestamptz,
  unique (carrier, tracking_number)
);

create index shipments_order_id_idx on public.shipments (order_id);
