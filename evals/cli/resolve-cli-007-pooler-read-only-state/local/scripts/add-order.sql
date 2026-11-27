-- Run by the signup job for each new order.
insert into public.orders (item) values ('Walnut desk') returning id, item;
