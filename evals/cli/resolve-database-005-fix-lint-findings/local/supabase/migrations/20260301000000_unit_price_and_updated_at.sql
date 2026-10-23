-- Prices are per unit now; the app reads order_items.unit_price.
alter table public.order_items rename column price to unit_price;

alter table public.orders
  add column updated_at timestamptz not null default now();

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();
