-- Run by the signup job for each new customer.
insert into public.customers (name, email)
values ('Priya Nair', 'priya.nair@example.com')
returning id, name, email;
