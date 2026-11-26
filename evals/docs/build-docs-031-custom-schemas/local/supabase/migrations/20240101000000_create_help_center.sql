-- This migration has already run on every environment. Anything new goes in a
-- new migration file, never in this one.

-- The help center's tables live in their own schema, apart from the app's
-- public ones. Visitors only ever see published articles.
create schema help_center;

create table help_center.articles (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null,
  published boolean not null default false
);

alter table help_center.articles enable row level security;

create policy "Visitors read published articles"
  on help_center.articles for select
  using (published);

insert into help_center.articles (title, body, published) values
  ('Resetting your password', 'Open Settings and choose Reset password.', true),
  ('Draft: new pricing', 'Not ready to show anyone yet.', false);

-- Staff records. These stay private: nothing about them is for the browser.
create schema staff;

create table staff.salaries (
  id bigint generated always as identity primary key,
  employee text not null,
  annual_pay_cents integer not null
);

insert into staff.salaries (employee, annual_pay_cents) values ('Ada', 9000000);
