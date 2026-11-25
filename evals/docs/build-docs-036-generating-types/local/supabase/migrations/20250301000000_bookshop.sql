create schema catalog;

grant usage on schema catalog to anon, authenticated, service_role;

create type catalog.book_format as enum ('paperback', 'hardcover', 'ebook');

create table catalog.books (
  id bigint generated always as identity primary key,
  title text not null,
  author text not null,
  price_cents integer not null,
  format catalog.book_format not null default 'paperback',
  blurb text
);

create function catalog.search_books(term text)
returns setof catalog.books
language sql
stable
set search_path = ''
as $$
  select *
  from catalog.books
  where title ilike '%' || term || '%'
     or author ilike '%' || term || '%'
  order by title;
$$;

grant select on catalog.books to anon, authenticated, service_role;
grant execute on function catalog.search_books(text) to anon, authenticated, service_role;

create table public.orders (
  id bigint generated always as identity primary key,
  book_id bigint not null references catalog.books (id),
  quantity integer not null default 1,
  gift_note text,
  placed_at timestamptz not null default now()
);

alter table public.orders enable row level security;
alter table catalog.books enable row level security;

create policy "Anyone can browse books"
on catalog.books for select
to anon, authenticated
using (true);

insert into catalog.books (title, author, price_cents, format, blurb) values
  ('The Quiet Orchard', 'Mara Ellison', 1899, 'hardcover', 'A family keeps an apple farm alive through one hard winter.'),
  ('Salt and Signal', 'Tomas Reyes', 1299, 'paperback', null),
  ('Night Ferry', 'Ada Okafor', 899, 'ebook', 'Strangers share a crossing and a secret.');
