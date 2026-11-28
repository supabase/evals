// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-cli-006-null-byte-string-literal
import { describe, expect, it } from 'vitest';
import {
  fakeContext,
  type FakePsql,
  shellCall,
} from '../lib/docurl-testing.js';
import scorer, {
  ASSETS_CHECK,
  REGISTER_CHECK,
  UNCHANGED_CHECK,
} from './EVAL.js';
import {
  ARTICLE_URL,
  readSeedFile,
  SEEDED_ASSETS,
  SEEDED_ASSETS_SQL,
} from './fixtures.js';

const NUL = 'ERROR:  invalid byte sequence for encoding "UTF8": 0x00';
const script = readSeedFile('scripts/register-asset.sql');
const files = { 'scripts/register-asset.sql': script };

const fixed: FakePsql = (sql) => {
  if (sql === SEEDED_ASSETS_SQL)
    return { stdout: `${SEEDED_ASSETS.join('\n')}\n` };
  if (sql.startsWith('begin;'))
    return { stdout: '2|C:\\0ps\\raw\\scan-002.tif\nt\n' };
  return {};
};

const stillBroken: FakePsql = (sql) =>
  sql.startsWith('begin;') ? { ok: false, stderr: NUL } : fixed(sql, '');

/** The script was rewritten to escape the backslashes, so the stored text differs. */
const storedDifferently: FakePsql = (sql) =>
  sql.startsWith('begin;')
    ? { stdout: '2|C:ps aw\\scan\nf\n' }
    : fixed(sql, '');

const find = (checks: { name: string }[] | undefined, name: string) =>
  checks?.find((check) => check.name === name) as
    | { passed: boolean; notes?: string }
    | undefined;

describe('resolve-cli-006 scorer', () => {
  it('passes a fixed database with the script unchanged', async () => {
    const result = await scorer(fakeContext({ psql: fixed, files }));
    expect(result.passed).toBe(true);
    expect(result.checks?.map((c) => c.name)).toEqual([
      'local stack is running for this project',
      ASSETS_CHECK,
      UNCHANGED_CHECK,
      REGISTER_CHECK,
      'read_doc_url',
      'saw_doc_url',
    ]);
  });

  it('wraps the script in a transaction that rolls back', async () => {
    const seen: string[] = [];
    await scorer(
      fakeContext({
        psql: (sql, url) => {
          seen.push(sql);
          return fixed(sql, url);
        },
        files,
      })
    );
    const run = seen.find((sql) => sql.startsWith('begin;'));
    expect(run).toContain('insert into public.assets');
    expect(run?.trimEnd().endsWith('rollback;')).toBe(true);
  });

  it('fails while the script still raises the null byte error', async () => {
    const result = await scorer(fakeContext({ psql: stillBroken, files }));
    expect(result.passed).toBe(false);
    expect(find(result.checks, REGISTER_CHECK)?.notes).toContain('0x00');
  });

  it('fails when the script was edited, even if it runs', async () => {
    const edited = {
      'scripts/register-asset.sql': script.replace('\\0ps', '\\\\0ps'),
    };
    const result = await scorer(fakeContext({ psql: fixed, files: edited }));
    expect(result.passed).toBe(false);
    expect(find(result.checks, UNCHANGED_CHECK)?.passed).toBe(false);
  });

  it('fails when the stored path is not the literal text', async () => {
    const result = await scorer(
      fakeContext({ psql: storedDifferently, files })
    );
    expect(find(result.checks, REGISTER_CHECK)?.passed).toBe(false);
  });

  it('fails when the seeded asset is gone', async () => {
    const psql: FakePsql = (sql, url) =>
      sql === SEEDED_ASSETS_SQL ? { stdout: '' } : fixed(sql, url);
    const result = await scorer(fakeContext({ psql, files }));
    expect(find(result.checks, ASSETS_CHECK)?.passed).toBe(false);
  });

  it('keeps read_doc_url out of the pass decision', async () => {
    const read = await scorer(
      fakeContext({
        psql: fixed,
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
        psql: fixed,
        files,
        toolCalls: [
          shellCall(
            'supabase db query -f scripts/register-asset.sql',
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
