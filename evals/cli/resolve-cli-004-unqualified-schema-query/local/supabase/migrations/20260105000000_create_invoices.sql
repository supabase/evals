create schema billing;

create table billing.invoices (
  id bigint generated always as identity primary key,
  customer text not null,
  amount_cents integer not null,
  issued_on date not null
);
