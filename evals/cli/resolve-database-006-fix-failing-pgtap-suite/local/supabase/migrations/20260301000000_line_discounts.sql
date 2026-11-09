-- Optional discount on a line, as a percentage off that line's amount.
alter table public.invoice_lines
  add column discount_percent integer not null
    check (discount_percent between 0 and 100);

create or replace function public.invoice_total_cents(p_invoice_id bigint)
returns bigint
language sql
stable
as $$
  select coalesce(sum(l.quantity * l.unit_price_cents * l.discount_percent / 100), 0)::bigint
  from public.invoice_lines l
  where l.invoice_id = p_invoice_id;
$$;
