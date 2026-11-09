begin;
select plan(4);

select has_function('public', 'invoice_total_cents', array['bigint']);

insert into public.invoices (id, customer_name) values
  (900001, 'Totals Test Ltd'),
  (900002, 'Empty Invoice Ltd');

insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents) values
  (900001, 'Consulting hours', 2, 1500),
  (900001, 'Setup fee', 1, 2500);

select is(
  public.invoice_total_cents(900001),
  5500::bigint,
  'an invoice total is the sum of quantity times unit price'
);

select is(
  public.invoice_total_cents(900002),
  0::bigint,
  'an invoice with no lines totals zero'
);

select throws_ok(
  $$insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents)
    values (900001, 'Nothing', 0, 100)$$,
  '23514',
  null,
  'a line needs a positive quantity'
);

select * from finish();
rollback;
