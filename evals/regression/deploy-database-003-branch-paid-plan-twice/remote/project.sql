insert into public.customers (email, full_name) values
  ('maya@example.com', 'Maya Lin'),
  ('owen@example.com', 'Owen Baptiste'),
  ('priya@example.com', 'Priya Nair');

insert into public.orders (customer_id, total_cents, status) values
  (1, 4200, 'paid'),
  (1, 1850, 'shipped'),
  (2, 9900, 'pending'),
  (3, 2500, 'cancelled');
