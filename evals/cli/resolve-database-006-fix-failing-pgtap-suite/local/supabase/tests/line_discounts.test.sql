begin;
select plan(5);

select has_column('public', 'invoice_lines', 'discount_percent', 'invoice lines have a discount column');

insert into public.invoices (id, customer_name) values
  (900101, 'Discount Test Ltd'),
  (900102, 'Mixed Lines Ltd'),
  (900103, 'Free Sample Ltd');

insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents, discount_percent) values
  (900101, 'Consulting hours', 2, 1500, 10),
  (900102, 'Annual licence', 1, 4000, 25),
  (900102, 'Support plan', 1, 1000, 0),
  (900103, 'Sample pack', 3, 700, 100);

select is(
  public.invoice_total_cents(900101),
  2700::bigint,
  'a 10% discount takes 10% off the line'
);

select is(
  public.invoice_total_cents(900102),
  4000::bigint,
  'discounted and full-price lines add up'
);

select is(
  public.invoice_total_cents(900103),
  0::bigint,
  'a 100% discount makes the line free'
);

select throws_ok(
  $$insert into public.invoice_lines (invoice_id, description, quantity, unit_price_cents, discount_percent)
    values (900101, 'Too generous', 1, 100, 101)$$,
  '23514',
  null,
  'a discount cannot be more than 100%'
);

select * from finish();
rollback;
