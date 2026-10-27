create table public.customers (
  id bigint generated always as identity primary key,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table public.legacy_coupons (
  code text primary key,
  customer_id bigint references public.customers (id),
  percent_off integer not null,
  issued_at timestamptz not null default now(),
  redeemed_at timestamptz
);
