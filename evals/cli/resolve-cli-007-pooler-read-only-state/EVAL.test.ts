// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-cli-007-pooler-read-only-state
import { describe, expect, it } from 'vitest';
import {
  fakeContext,
  type FakePsql,
  shellCall,
} from '../lib/docurl-testing.js';
import scorer, { ORDERS_CHECK, READ_ONLY_CHECK, SIGNUP_CHECK } from './EVAL.js';
import {
  ARTICLE_URL,
  POOLER_URL,
  readSeedFile,
  ROUNDS,
  SEEDED_ORDERS,
  SEEDED_ORDERS_SQL,
  SIGNUP_INSERT_SQL,
} from './fixtures.js';

const READ_ONLY = 'ERROR:  cannot execute INSERT in a read-only transaction';
const original = readSeedFile('scripts/nightly-report.sql');
const fixedReport = `-- Nightly order report.
begin read only;
select count(*) as orders from public.orders;
commit;
`;

const admin: FakePsql = (sql) =>
  sql === SEEDED_ORDERS_SQL ? { stdout: `${SEEDED_ORDERS.join('\n')}\n` } : {};

/** A pool that works: the report leaves no state behind. */
const clean: FakePsql = (sql, url) =>
  url === POOLER_URL ? {} : admin(sql, url);

/** A pool where each run of the original report leaves one backend read-only. */
function contaminatedBy(
  reportText: string,
  startContaminated = false
): FakePsql {
  let readOnly = startContaminated;
  return (sql, url) => {
    if (url !== POOLER_URL) return admin(sql, url);
    if (sql === reportText) {
      if (/set default_transaction_read_only = on/i.test(sql)) readOnly = true;
      return {};
    }
    if (sql === SIGNUP_INSERT_SQL && readOnly)
      return { ok: false, stderr: READ_ONLY };
    return {};
  };
}

const find = (checks: { name: string }[] | undefined, name: string) =>
  checks?.find((check) => check.name === name) as
    | { passed: boolean; notes?: string }
    | undefined;

describe('resolve-cli-007 scorer', () => {
  it('passes a report that keeps the state inside its transaction', async () => {
    const result = await scorer(
      fakeContext({
        psql: contaminatedBy(fixedReport),
        files: { 'scripts/nightly-report.sql': fixedReport },
      })
    );
    expect(result.passed).toBe(true);
    expect(result.checks?.map((c) => c.name)).toEqual([
      'local stack is running for this project',
      ORDERS_CHECK,
      READ_ONLY_CHECK,
      SIGNUP_CHECK,
      'read_doc_url',
      'saw_doc_url',
    ]);
  });

  it('fails the original report, which leaves a backend read-only', async () => {
    const result = await scorer(
      fakeContext({
        psql: contaminatedBy(original),
        files: { 'scripts/nightly-report.sql': original },
      })
    );
    expect(result.passed).toBe(false);
    const signup = find(result.checks, SIGNUP_CHECK);
    expect(signup?.passed).toBe(false);
    expect(signup?.notes).toContain('after report run 1');
    expect(signup?.notes).toContain('read-only transaction');
  });

  it('fails a pool that a fixed script left contaminated before the scorer ran', async () => {
    const result = await scorer(
      fakeContext({
        psql: contaminatedBy(fixedReport, true),
        files: { 'scripts/nightly-report.sql': fixedReport },
      })
    );
    const signup = find(result.checks, SIGNUP_CHECK);
    expect(signup?.passed).toBe(false);
    expect(signup?.notes).toContain('before any report run');
  });

  it('fails a report that drops the read-only guard', async () => {
    const dropped = 'select count(*) as orders from public.orders;\n';
    const result = await scorer(
      fakeContext({
        psql: clean,
        files: { 'scripts/nightly-report.sql': dropped },
      })
    );
    expect(result.passed).toBe(false);
    expect(find(result.checks, SIGNUP_CHECK)?.passed).toBe(true);
    expect(find(result.checks, READ_ONLY_CHECK)?.passed).toBe(false);
  });

  it('runs the signup insert once, then the report and the signup for each round', async () => {
    const seen: string[] = [];
    await scorer(
      fakeContext({
        psql: (sql, url) => {
          if (url === POOLER_URL)
            seen.push(sql === SIGNUP_INSERT_SQL ? 'signup' : 'report');
          return clean(sql, url);
        },
        files: { 'scripts/nightly-report.sql': fixedReport },
      })
    );
    expect(seen).toHaveLength(1 + 2 * ROUNDS);
    expect(seen[0]).toBe('signup');
    expect(seen.slice(1, 3)).toEqual(['report', 'signup']);
  });

  it('fails when a seeded order is gone', async () => {
    const psql: FakePsql = (sql, url) =>
      url !== POOLER_URL && sql === SEEDED_ORDERS_SQL
        ? { stdout: '' }
        : clean(sql, url);
    const result = await scorer(
      fakeContext({
        psql,
        files: { 'scripts/nightly-report.sql': fixedReport },
      })
    );
    expect(find(result.checks, ORDERS_CHECK)?.passed).toBe(false);
  });

  it('keeps read_doc_url out of the pass decision', async () => {
    const files = { 'scripts/nightly-report.sql': fixedReport };
    const read = await scorer(
      fakeContext({
        psql: clean,
        files,
        toolCalls: [shellCall(`curl -sL ${ARTICLE_URL}`, 'article text')],
      })
    );
    expect(read.passed).toBe(true);
    expect(find(read.checks, 'read_doc_url')?.notes).toContain(
      'read_doc_url=true'
    );
  });

  it('reports saw_doc_url when a CLI output carries the link', async () => {
    const result = await scorer(
      fakeContext({
        psql: clean,
        files: { 'scripts/nightly-report.sql': fixedReport },
        toolCalls: [
          shellCall(
            'supabase db query --remote "$POOLER_URL" --yes -f scripts/add-order.sql',
            `Learn more: ${ARTICLE_URL}`
          ),
        ],
      })
    );
    expect(find(result.checks, 'saw_doc_url')?.notes).toContain(
      'saw_doc_url=true'
    );
  });
});
