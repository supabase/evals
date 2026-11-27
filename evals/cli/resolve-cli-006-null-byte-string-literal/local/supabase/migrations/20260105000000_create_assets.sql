create table public.assets (
  id serial primary key,
  path text not null,
  label text not null
);
