// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-cli-004-unqualified-schema-query
import { describe, expect, it } from 'vitest';
import {
  fakeContext,
  type FakePsql,
  shellCall,
} from '../lib/docurl-testing.js';
import scorer, { INVOICES_CHECK, REPORT_CHECK, SCRIPT_CHECK } from './EVAL.js';
import {
  ARTICLE_URL,
  EXPECTED_INVOICES,
  EXPECTED_REPORT,
  INVOICES_SQL,
  readSeedFile,
  REPORT_SCRIPT,
} from './fixtures.js';

const ORIGINAL = readSeedFile(REPORT_SCRIPT);
const QUALIFIED = ORIGINAL.replace('from invoices', 'from billing.invoices');

const reportIfQualified: FakePsql = (sql) => {
  if (sql === INVOICES_SQL) return { stdout: `${EXPECTED_INVOICES}\n` };
  return /from billing\.invoices/.test(sql)
    ? { stdout: `${EXPECTED_REPORT.join('\n')}\n` }
    : { ok: false, stderr: 'ERROR:  relation "invoices" does not exist' };
};

const find = (checks: { name: string }[] | undefined, name: string) =>
  checks?.find((check) => check.name === name);

describe('resolve-cli-004 scorer', () => {
  it('passes a script that qualifies the schema', async () => {
    const result = await scorer(
      fakeContext({
        psql: reportIfQualified,
        files: { [REPORT_SCRIPT]: QUALIFIED },
      })
    );
    expect(result.passed).toBe(true);
    expect(result.checks?.map((c) => c.name)).toEqual([
      'local stack is running for this project',
      INVOICES_CHECK,
      SCRIPT_CHECK,
      REPORT_CHECK,
      'read_doc_url',
      'saw_doc_url',
    ]);
  });

  it('fails the original script', async () => {
    const result = await scorer(
      fakeContext({
        psql: reportIfQualified,
        files: { [REPORT_SCRIPT]: ORIGINAL },
      })
    );
    expect(result.passed).toBe(false);
    expect(find(result.checks, REPORT_CHECK)).toMatchObject({
      passed: false,
      notes: expect.stringContaining('invoices'),
    });
  });

  it('fails when the invoices moved or changed', async () => {
    const psql: FakePsql = (sql) =>
      sql === INVOICES_SQL
        ? {
            ok: false,
            stderr: 'ERROR:  relation "billing.invoices" does not exist',
          }
        : reportIfQualified(sql);
    const result = await scorer(
      fakeContext({ psql, files: { [REPORT_SCRIPT]: QUALIFIED } })
    );
    expect(find(result.checks, INVOICES_CHECK)?.passed).toBe(false);
  });

  it('fails a script that hard-codes the numbers', async () => {
    const hardCoded = "select 'Acme Corp', 20000;\n";
    const result = await scorer(
      fakeContext({
        psql: () => ({ stdout: `${EXPECTED_REPORT.join('\n')}\n` }),
        files: { [REPORT_SCRIPT]: hardCoded },
      })
    );
    expect(find(result.checks, SCRIPT_CHECK)?.passed).toBe(false);
  });

  it('fails when the report differs from the invoices', async () => {
    const result = await scorer(
      fakeContext({
        psql: (sql) =>
          sql === INVOICES_SQL
            ? { stdout: `${EXPECTED_INVOICES}\n` }
            : { stdout: 'Acme Corp|1\n' },
        files: { [REPORT_SCRIPT]: QUALIFIED },
      })
    );
    expect(find(result.checks, REPORT_CHECK)?.passed).toBe(false);
  });

  it('fails when the script is missing', async () => {
    const result = await scorer(fakeContext({ psql: reportIfQualified }));
    expect(result.passed).toBe(false);
    expect(find(result.checks, SCRIPT_CHECK)?.notes).toContain('cannot read');
  });

  it('records read_doc_url without gating on it', async () => {
    const result = await scorer(
      fakeContext({
        psql: reportIfQualified,
        files: { [REPORT_SCRIPT]: QUALIFIED },
        toolCalls: [shellCall(`curl -sL ${ARTICLE_URL}`, 'article text')],
      })
    );
    expect(result.passed).toBe(true);
    expect(find(result.checks, 'read_doc_url')?.notes).toContain(
      'read_doc_url=true'
    );
  });
});
