import { readFileSync } from 'node:fs';

/** The article the CLI links for SQLSTATE 42P01 (supabase/cli#7749). */
export const ARTICLE_URL =
  'https://supabase.com/kb/troubleshooting/resolving-42p01-relation-does-not-exist-error-W4_9-V';

export const REPORT_SCRIPT = 'scripts/monthly-revenue.sql';

/** What the revenue report prints for the seeded invoices, as `customer|total_cents` lines. */
export const EXPECTED_REPORT = [
  'Acme Corp|20000',
  'Birch Ltd|6000',
  'Cedar LLC|25000',
];

export const INVOICES_SQL =
  'select count(*), sum(amount_cents) from billing.invoices;';
export const EXPECTED_INVOICES = '6|51000';

export function readSeedFile(path: string): string {
  return readFileSync(new URL(`./local/${path}`, import.meta.url), 'utf8');
}
