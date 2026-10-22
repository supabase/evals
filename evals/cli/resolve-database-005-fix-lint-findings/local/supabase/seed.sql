insert into public.orders (id, user_id, status) values
  (1, '6f1c2a3e-0b7d-4c55-9a1e-2d3f4b5c6d71', 'shipped'),
  (2, '6f1c2a3e-0b7d-4c55-9a1e-2d3f4b5c6d71', 'open'),
  (3, 'b8e4d2c1-7a6f-4e3d-8c2b-1a0f9e8d7c62', 'open');

select setval(pg_get_serial_sequence('public.orders', 'id'), 3);

insert into public.order_items (order_id, product, quantity, unit_price) values
  (1, 'Coffee beans', 2, 12.50),
  (1, 'Filter papers', 1, 5.00),
  (2, 'Mug', 3, 4.00),
  (3, 'Grinder', 1, 99.99);
