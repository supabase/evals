create table public.profiles (
  id int primary key,
  display_name text not null,
  email text not null,
  joined_at date not null
);

-- The public profile page connects as app_reader.
create role app_reader login password 'readerpw';
grant usage on schema public to app_reader;

-- Column-level access, as set in the Dashboard: the page may read everything except the email.
grant select (id, display_name, joined_at) on public.profiles to app_reader;
