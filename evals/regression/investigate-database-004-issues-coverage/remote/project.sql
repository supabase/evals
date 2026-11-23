create table public.customer_contacts (
  id integer primary key,
  email text not null
);

create table public.invoices (
  id integer primary key,
  customer_id integer not null,
  amount_cents integer not null
);

create table public.release_notes (
  id integer primary key,
  title text not null
);

alter table public.release_notes enable row level security;

insert into public.customer_contacts values (1, 'customer@example.com');
insert into public.invoices values (1, 1, 4900);
insert into public.release_notes values (1, 'Initial release');
