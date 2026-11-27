import { readFileSync } from 'node:fs';

/** The article the CLI links for SQLSTATE 23505 (supabase/cli#7749). */
export const ARTICLE_URL =
  'https://supabase.com/kb/troubleshooting/inserting-into-sequenceserial-table-causes-duplicate-key-violates-unique-constraint-error-pi6DnC';

/** The customers the seed inserts with explicit ids, as `id|email` lines. */
export const SEEDED_CUSTOMERS = [
  '1|ana.costa@example.com',
  '2|ben.okafor@example.com',
  '3|chen.wei@example.com',
  '4|dara.singh@example.com',
  '5|elif.demir@example.com',
];

export const SEEDED_CUSTOMERS_SQL =
  'select id, email from public.customers where id <= 5 order by id;';

/** The signup job's insert shape, with emails that are not in the seed. Rolled back after the check. */
export const SIGNUP_INSERT_SQL = `begin;
insert into public.customers (name, email)
values ('Scorer One', 'scorer-1@example.invalid');
insert into public.customers (name, email)
values ('Scorer Two', 'scorer-2@example.invalid');
rollback;
`;

export function readSeedFile(path: string): string {
  return readFileSync(new URL(`./local/${path}`, import.meta.url), 'utf8');
}
