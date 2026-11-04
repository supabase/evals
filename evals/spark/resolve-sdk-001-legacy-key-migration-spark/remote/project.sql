create table public.posts (
  id bigserial primary key,
  title text not null,
  published boolean not null default false
);

insert into public.posts (title, published) values
  ('Announcing vector buckets', true),
  ('Realtime broadcast tips', true),
  ('Row level security explained', true),
  ('DRAFT: pricing update', false),
  ('DRAFT: roadmap 2027', false);
