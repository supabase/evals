import { readFileSync } from 'node:fs';

/** The article the CLI links for SQLSTATE 42501 (supabase/cli#7749). */
export const ARTICLE_URL =
  'https://supabase.com/kb/troubleshooting/database-api-42501-errors';

export const LIST_SCRIPT = 'scripts/list-profiles.sql';

/** The connection string the profile page uses. The role has column-level `select` only. */
export const READER_URL =
  'postgresql://app_reader:readerpw@127.0.0.1:54322/postgres?sslmode=disable';

/** The members the seed inserts, as `id|display_name|email` lines (read as the admin role). */
export const SEEDED_PROFILES = [
  '1|Ana C.|ana.costa@example.com',
  '2|Ben O.|ben.okafor@example.com',
  '3|Chen W.|chen.wei@example.com',
];
export const SEEDED_PROFILES_SQL =
  'select id, display_name, email from public.profiles order by id;';

/** What the page needs to see per member, so the list is not an empty or fixed output. */
export const DISPLAY_NAMES = ['Ana C.', 'Ben O.', 'Chen W.'];

/** The private column the page role must never be able to read. */
export const EMAIL_SQL = 'select email from public.profiles;';

export function readSeedFile(path: string): string {
  return readFileSync(new URL(`./local/${path}`, import.meta.url), 'utf8');
}
