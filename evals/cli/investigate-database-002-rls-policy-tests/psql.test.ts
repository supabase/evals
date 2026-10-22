// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-002-rls-policy-tests
import { describe, expect, it } from 'vitest';
import { compareText, psqlCommand } from './psql.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

describe('psqlCommand', () => {
  it('quotes the url and stops at the first error', () => {
    expect(psqlCommand(DB_URL, ['-c "select 1"'])).toBe(
      `psql '${DB_URL}' -X -A -t -q -v ON_ERROR_STOP=1 -c "select 1"`
    );
  });

  it('pipes a script to stdin as base64 so no quoting can break it', () => {
    const script = `select 'it''s';\n-- "quoted" $$ dollars\n`;
    const command = psqlCommand(DB_URL, ['-f -'], script);
    const encoded = Buffer.from(script, 'utf8').toString('base64');
    expect(command).toBe(
      `printf %s '${encoded}' | base64 -d | psql '${DB_URL}' -X -A -t -q -v ON_ERROR_STOP=1 -f -`
    );
  });
});

describe('compareText', () => {
  it('orders by code unit, not by locale', () => {
    expect(['b', 'B', 'a'].sort(compareText)).toEqual(['B', 'a', 'b']);
    expect(compareText('a', 'a')).toBe(0);
  });
});
