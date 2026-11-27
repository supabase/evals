create table public.articles (
  id bigint generated always as identity primary key,
  slug text not null unique,
  title text not null,
  body text not null
);

-- The same body must never be published twice.
create unique index articles_body_key on public.articles (body);
