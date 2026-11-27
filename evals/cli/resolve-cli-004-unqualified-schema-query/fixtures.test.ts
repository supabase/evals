import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ARTICLE_URL,
  EXPECTED_INVOICES,
  EXPECTED_REPORT,
  readSeedFile,
} from './fixtures.js';

type Invoice = { customer: string; cents: number };

function seededInvoices(): Invoice[] {
  const seed = readSeedFile('supabase/seed.sql');
  return [...seed.matchAll(/\('([^']+)', (\d+), '/g)].map((m) => ({
    customer: m[1],
    cents: Number(m[2]),
  }));
}

describe('resolve-cli-004 fixtures', () => {
  it('derives the expected report and totals from the seed', () => {
    const invoices = seededInvoices();
    const totals = new Map<string, number>();
    for (const { customer, cents } of invoices) {
      totals.set(customer, (totals.get(customer) ?? 0) + cents);
    }
    const lines = [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([customer, cents]) => `${customer}|${cents}`);
    expect(lines).toEqual(EXPECTED_REPORT);
    expect(EXPECTED_INVOICES).toBe(
      `${invoices.length}|${invoices.reduce((sum, i) => sum + i.cents, 0)}`
    );
  });

  it('puts the table in billing and reads it unqualified in the script', () => {
    expect(
      readSeedFile('supabase/migrations/20260105000000_create_invoices.sql')
    ).toContain('create table billing.invoices');
    expect(readSeedFile('scripts/monthly-revenue.sql')).toMatch(
      /from invoices\b/
    );
  });

  it('never names the error, the article or the fix in the prompt', () => {
    const prompt = readFileSync(
      new URL('./PROMPT.md', import.meta.url),
      'utf8'
    );
    expect(prompt).not.toMatch(
      /42P01|SQLSTATE|does not exist|schema|search_path|billing|kb\/troubleshooting|supabase\.com/i
    );
    expect(ARTICLE_URL).toMatch(
      /^https:\/\/supabase\.com\/kb\/troubleshooting\//
    );
  });
});
