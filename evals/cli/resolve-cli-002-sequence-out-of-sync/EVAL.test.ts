// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-cli-002-sequence-out-of-sync
import { describe, expect, it } from 'vitest';
import {
  fakeContext,
  type FakePsql,
  shellCall,
} from '../lib/docurl-testing.js';
import scorer, { CUSTOMERS_CHECK, SIGNUP_CHECK } from './EVAL.js';
import {
  ARTICLE_URL,
  SEEDED_CUSTOMERS,
  SEEDED_CUSTOMERS_SQL,
} from './fixtures.js';

const DUPLICATE =
  'ERROR:  duplicate key value violates unique constraint "customers_pkey"';

const healthy: FakePsql = (sql) =>
  sql === SEEDED_CUSTOMERS_SQL
    ? { stdout: `${SEEDED_CUSTOMERS.join('\n')}\n` }
    : {};

const outOfSync: FakePsql = (sql) =>
  sql.includes('insert into public.customers')
    ? { ok: false, stderr: DUPLICATE }
    : healthy(sql);

const names = (checks: { name: string }[] | undefined) =>
  checks?.map((check) => check.name);

describe('resolve-cli-002 scorer', () => {
  it('passes a fixed database', async () => {
    const result = await scorer(fakeContext({ psql: healthy }));
    expect(result.passed).toBe(true);
    expect(names(result.checks)).toEqual([
      'local stack is running for this project',
      CUSTOMERS_CHECK,
      SIGNUP_CHECK,
      'read_doc_url',
      'saw_doc_url',
    ]);
  });

  it('fails while the signup insert still collides', async () => {
    const result = await scorer(fakeContext({ psql: outOfSync }));
    expect(result.passed).toBe(false);
    const signup = result.checks?.find((c) => c.name === SIGNUP_CHECK);
    expect(signup?.passed).toBe(false);
    expect(signup?.notes).toContain('duplicate key');
  });

  it('fails when a seeded customer is gone', async () => {
    const psql: FakePsql = (sql) =>
      sql === SEEDED_CUSTOMERS_SQL
        ? { stdout: `${SEEDED_CUSTOMERS.slice(1).join('\n')}\n` }
        : {};
    const result = await scorer(fakeContext({ psql }));
    const check = result.checks?.find((c) => c.name === CUSTOMERS_CHECK);
    expect(check?.passed).toBe(false);
    expect(check?.notes).toContain(SEEDED_CUSTOMERS[0]);
  });

  it('keeps read_doc_url out of the pass decision', async () => {
    const read = await scorer(
      fakeContext({
        psql: healthy,
        toolCalls: [shellCall(`curl -sL ${ARTICLE_URL}`, 'article text')],
      })
    );
    const unread = await scorer(fakeContext({ psql: healthy }));
    expect(read.passed).toBe(true);
    expect(unread.passed).toBe(true);
    expect(
      read.checks?.find((c) => c.name === 'read_doc_url')?.notes
    ).toContain('read_doc_url=true');
    expect(
      unread.checks?.find((c) => c.name === 'read_doc_url')?.notes
    ).toContain('read_doc_url=false');
  });

  it('reports saw_doc_url when a CLI output carries the link', async () => {
    const result = await scorer(
      fakeContext({
        psql: healthy,
        toolCalls: [
          shellCall(
            'supabase db query --local -f scripts/add-customer.sql',
            `Learn more: ${ARTICLE_URL}`
          ),
        ],
      })
    );
    expect(
      result.checks?.find((c) => c.name === 'saw_doc_url')?.notes
    ).toContain('saw_doc_url=true');
  });
});
