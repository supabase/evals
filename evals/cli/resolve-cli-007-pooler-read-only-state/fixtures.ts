import { readFileSync } from 'node:fs';

/** The article the CLI links for SQLSTATE 25006 (supabase/cli#7749). */
export const ARTICLE_URL =
  'https://supabase.com/kb/troubleshooting/resolving-cannot-execute-update-in-a-read-only-transaction-on-transaction-pooler-connections';

export const REPORT_SCRIPT = 'scripts/nightly-report.sql';

/** The local transaction pooler (Supavisor). The tenant id is `pooler-dev` for every local project. */
export const POOLER_URL =
  'postgresql://postgres.pooler-dev:postgres@127.0.0.1:54329/postgres?sslmode=disable';

/** The orders the seed inserts, as `item` lines. */
export const SEEDED_ORDERS = ['Oak shelf', 'Linen cushion', 'Brass lamp'];
export const SEEDED_ORDERS_SQL =
  "select item from public.orders where item in ('Oak shelf', 'Linen cushion', 'Brass lamp') order by id;";

/** The signup insert, rolled back so the table stays as seeded. Sent through the pooler. */
export const SIGNUP_INSERT_SQL = `begin;
insert into public.orders (item) values ('Scorer desk');
rollback;
`;

/** How many times the scorer runs "report, then signup" through the pooler. */
export const ROUNDS = 4;

export function readSeedFile(path: string): string {
  return readFileSync(new URL(`./local/${path}`, import.meta.url), 'utf8');
}
