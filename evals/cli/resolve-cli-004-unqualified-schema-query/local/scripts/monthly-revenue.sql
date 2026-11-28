-- Revenue per customer, run by finance at month end.
select customer, sum(amount_cents) as total_cents
from invoices
group by customer
order by customer;
