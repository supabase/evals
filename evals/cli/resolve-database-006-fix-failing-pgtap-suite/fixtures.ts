import { readFileSync } from 'node:fs';

export const MIGRATIONS_DIR = 'supabase/migrations';
export const TESTS_DIR = 'supabase/tests';

export const SEEDED_MIGRATIONS: readonly string[] = [
  '20260101000000_create_invoices.sql',
  '20260301000000_line_discounts.sql',
];

export const SEEDED_TEST_FILES: readonly string[] = [
  'invoice_totals.test.sql',
  'line_discounts.test.sql',
];

export const REPLAY_DATABASE = 'eval_replay';

/** The contents of `local/<relativePath>`, the project the agent starts from. */
export function readSeedFile(relativePath: string): string {
  return readFileSync(
    new URL(`./local/${relativePath}`, import.meta.url),
    'utf8'
  );
}

/** The pristine seeded tests, in `SEEDED_TEST_FILES` order. */
export const SEEDED_TESTS: readonly { file: string; sql: string }[] =
  SEEDED_TEST_FILES.map((file) => ({
    file,
    sql: readSeedFile(`${TESTS_DIR}/${file}`),
  }));
