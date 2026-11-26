-- Staff records live in their own schema, apart from anything the help center
-- shows customers. The help center's tables (articles and the rest) are made by
-- the app, in public.
create schema hr;

create table hr.salaries (
  id bigint generated always as identity primary key,
  employee text not null,
  annual_pay_cents integer not null
);
