create table public.orders (
  id bigint generated always as identity primary key,
  customer_id uuid not null,
  status text not null default 'placed'
    check (status in ('placed', 'packed', 'shipped', 'delivered', 'cancelled')),
  delivery_note text,
  created_at timestamptz not null default now()
);

alter table public.orders enable row level security;

create policy "Customers can read their own orders"
  on public.orders for select
  to authenticated
  using (customer_id = (select auth.uid()));

create policy "Customers can update their own orders"
  on public.orders for update
  to authenticated
  using (customer_id = (select auth.uid()))
  with check (customer_id = (select auth.uid()));

create table public.order_status_history (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders (id) on delete cascade,
  old_status text,
  new_status text not null,
  changed_at timestamptz not null default now()
);

alter table public.order_status_history enable row level security;

create policy "Customers can read the history of their own orders"
  on public.order_status_history for select
  to authenticated
  using (
    exists (
      select 1 from public.orders o
      where o.id = order_id and o.customer_id = (select auth.uid())
    )
  );

insert into public.orders (customer_id, status, delivery_note) values
  ('8d0f6c1e-2b7a-4c39-9e51-3f4a7b2d6c10', 'shipped', 'Leave it with the neighbour'),
  ('8d0f6c1e-2b7a-4c39-9e51-3f4a7b2d6c10', 'placed', null),
  ('c45e2a90-71d3-4f8b-a6e2-9b1c0d3e5f27', 'packed', 'Ring twice');
