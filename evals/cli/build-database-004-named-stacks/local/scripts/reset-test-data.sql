-- Wipes every order and loads the fixtures the integration tests assert
-- against. Destructive: only ever run this against the test database.
begin;

truncate table public.orders restart identity;

insert into public.orders (customer, item, quantity) values
  ('fixture-customer-1', 'fixture-widget', 1),
  ('fixture-customer-2', 'fixture-gadget', 2),
  ('fixture-customer-3', 'fixture-gizmo', 3);

commit;
