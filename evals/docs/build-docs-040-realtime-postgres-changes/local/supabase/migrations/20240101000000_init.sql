create table public.orders (
  id bigint generated always as identity primary key,
  customer_id uuid not null references auth.users (id) on delete cascade,
  item text not null,
  status text not null default 'placed'
    check (status in ('placed', 'packed', 'shipped', 'delivered')),
  updated_at timestamptz not null default now()
);

create index orders_customer_id_idx on public.orders (customer_id);

alter table public.orders enable row level security;

create table public.shop_status (
  id int primary key,
  is_open boolean not null,
  message text not null
);

alter table public.shop_status enable row level security;

create policy "Everyone can see whether the shop is open"
  on public.shop_status for select
  to anon, authenticated
  using (true);

insert into public.shop_status (id, is_open, message)
values (1, true, 'Open until 6pm');

alter publication supabase_realtime add table public.shop_status;
