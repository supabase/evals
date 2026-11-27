-- Run by the editors to publish the Q1 handbook. The body is about 5 KB of text.
insert into public.articles (slug, title, body)
select
  'q1-handbook',
  'Q1 handbook',
  string_agg(md5(i::text), '' order by i)
from generate_series(1, 150) as i
returning id, slug, title, length(body) as body_length;
