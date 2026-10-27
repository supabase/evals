-- 1,200 customers from the shop's sign-up form.
insert into public.customers (id, email, full_name, created_at)
select
  md5('customer-' || n)::uuid,
  lower(first_name || '.' || last_name) || n || '@example.com',
  first_name || ' ' || last_name,
  timestamptz '2025-01-01 00:00:00+00' + n * interval '6 hours'
from generate_series(1, 1200) as n,
  lateral (
    select
      (array['Ada', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jun', 'Kai', 'Lena'])[1 + n % 12] as first_name,
      (array['Okafor', 'Silva', 'Novak', 'Haddad', 'Larsen', 'Moreau', 'Tanaka', 'Kowalski', 'Reyes', 'Brennan'])[1 + n % 10] as last_name
  ) as names;

-- 1,800 orders imported from the old shop.
insert into public.orders (customer_id, total_cents, created_at)
select
  md5('customer-' || (1 + ('x' || substr(md5('order-' || n), 1, 7))::bit(28)::int % 1200))::uuid,
  500 + (n * 37) % 20000,
  timestamptz '2025-02-01 00:00:00+00' + n * interval '4 hours'
from generate_series(1, 1800) as n;
