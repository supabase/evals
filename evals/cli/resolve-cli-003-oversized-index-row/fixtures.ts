import { readFileSync } from 'node:fs';

/** The article the CLI links for SQLSTATE 54000 (supabase/cli#7749). */
export const ARTICLE_URL =
  'https://supabase.com/kb/troubleshooting/error-index-row-size-exceeds-btree-version-4-maximum-for-index-LMmoeU';

/** The articles the seed inserts, as `slug|title` lines. */
export const SEEDED_ARTICLES = [
  'changelog-2026-01|Changelog January 2026',
  'pricing-faq|Pricing FAQ',
  'welcome|Welcome',
];

export const SEEDED_ARTICLES_SQL =
  "select slug, title from public.articles where slug in ('welcome', 'pricing-faq', 'changelog-2026-01') order by slug;";

/** A long body the publish job could send: 5 KB of hex text, above the 2704 byte btree limit. Rolled back after the check. */
export const LONG_INSERT_SQL = `begin;
insert into public.articles (slug, title, body)
select 'scorer-long', 'Scorer long', string_agg(md5((i + 5000)::text), '' order by i)
from generate_series(1, 150) as i;
rollback;
`;

/** The same body, short or long, must still be refused a second time. Rolled back after the check. */
export const UNIQUE_BODY_SQL = `begin;
do $$
declare
  long_body text := (select string_agg(md5((i + 9000)::text), '' order by i) from generate_series(1, 150) as i);
  short_body text := 'scorer short body';
begin
  insert into public.articles (slug, title, body) values ('scorer-long-1', 'Long 1', long_body);
  insert into public.articles (slug, title, body) values ('scorer-short-1', 'Short 1', short_body);
  begin
    insert into public.articles (slug, title, body) values ('scorer-long-2', 'Long 2', long_body);
    raise exception 'a repeated long body was accepted';
  exception when unique_violation then
    null;
  end;
  begin
    insert into public.articles (slug, title, body) values ('scorer-short-2', 'Short 2', short_body);
    raise exception 'a repeated short body was accepted';
  exception when unique_violation then
    null;
  end;
end
$$;
rollback;
`;

export function readSeedFile(path: string): string {
  return readFileSync(new URL(`./local/${path}`, import.meta.url), 'utf8');
}
