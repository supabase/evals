-- Nightly order report. It must never write, so it starts in read-only mode.
set default_transaction_read_only = on;
select count(*) as orders from public.orders;
