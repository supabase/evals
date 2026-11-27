// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-cli-005-select-star-column-privileges
import { describe, expect, it } from 'vitest';
import {
  fakeContext,
  type FakePsql,
  shellCall,
} from '../lib/docurl-testing.js';
import scorer, { LIST_CHECK, PRIVATE_CHECK, PROFILES_CHECK } from './EVAL.js';
import {
  ARTICLE_URL,
  READER_URL,
  SEEDED_PROFILES,
  SEEDED_PROFILES_SQL,
} from './fixtures.js';

const DENIED = 'ERROR:  permission denied for table profiles';
const LIST = 'select id, display_name, joined_at from public.profiles;';
const files = { 'scripts/list-profiles.sql': LIST };

/** The database after a correct fix: the list works, the email stays denied. */
const fixed: FakePsql = (sql, url) => {
  if (url !== READER_URL) {
    return sql === SEEDED_PROFILES_SQL
      ? { stdout: `${SEEDED_PROFILES.join('\n')}\n` }
      : {};
  }
  if (sql.includes('email')) return { ok: false, stderr: DENIED, exitCode: 1 };
  return {
    stdout: '1|Ana C.|2025-03-14\n2|Ben O.|2025-06-02\n3|Chen W.|2025-09-21\n',
  };
};

/** The wrong fix: a table-wide grant lets the page role read everything. */
const tableGrant: FakePsql = (sql, url) =>
  url === READER_URL
    ? { stdout: 'Ana C.\nBen O.\nChen W.\nx@example.com\n' }
    : fixed(sql, url);

/** Still broken: the page role cannot run the script. */
const broken: FakePsql = (sql, url) =>
  url === READER_URL ? { ok: false, stderr: DENIED } : fixed(sql, url);

const find = (checks: { name: string }[] | undefined, name: string) =>
  checks?.find((check) => check.name === name) as
    | { passed: boolean; notes?: string }
    | undefined;

describe('resolve-cli-005 scorer', () => {
  it('passes a correct fix', async () => {
    const result = await scorer(fakeContext({ psql: fixed, files }));
    expect(result.passed).toBe(true);
    expect(result.checks?.map((c) => c.name)).toEqual([
      'local stack is running for this project',
      PROFILES_CHECK,
      LIST_CHECK,
      PRIVATE_CHECK,
      'read_doc_url',
      'saw_doc_url',
    ]);
  });

  it('fails while the page role is denied', async () => {
    const result = await scorer(fakeContext({ psql: broken, files }));
    expect(result.passed).toBe(false);
    expect(find(result.checks, LIST_CHECK)?.passed).toBe(false);
    expect(find(result.checks, LIST_CHECK)?.notes).toContain(
      'permission denied'
    );
  });

  it('fails a table-wide grant that exposes the emails', async () => {
    const result = await scorer(fakeContext({ psql: tableGrant, files }));
    expect(result.passed).toBe(false);
    expect(find(result.checks, LIST_CHECK)?.passed).toBe(true);
    expect(find(result.checks, PRIVATE_CHECK)?.passed).toBe(false);
    expect(find(result.checks, PRIVATE_CHECK)?.notes).toContain(
      'read the emails'
    );
  });

  it('fails when the script cannot be read', async () => {
    const result = await scorer(fakeContext({ psql: fixed }));
    expect(find(result.checks, LIST_CHECK)?.passed).toBe(false);
  });

  it('fails when a seeded profile is gone', async () => {
    const psql: FakePsql = (sql, url) =>
      url !== READER_URL && sql === SEEDED_PROFILES_SQL
        ? { stdout: `${SEEDED_PROFILES.slice(1).join('\n')}\n` }
        : fixed(sql, url);
    const result = await scorer(fakeContext({ psql, files }));
    expect(find(result.checks, PROFILES_CHECK)?.passed).toBe(false);
  });

  it('keeps read_doc_url out of the pass decision', async () => {
    const read = await scorer(
      fakeContext({
        psql: fixed,
        files,
        toolCalls: [shellCall(`curl -sL ${ARTICLE_URL}.md`, 'article text')],
      })
    );
    const unread = await scorer(fakeContext({ psql: fixed, files }));
    expect(read.passed).toBe(true);
    expect(unread.passed).toBe(true);
    expect(find(read.checks, 'read_doc_url')?.notes).toContain(
      'read_doc_url=true'
    );
    expect(find(unread.checks, 'read_doc_url')?.notes).toContain(
      'read_doc_url=false'
    );
  });

  it('reports saw_doc_url when a CLI output carries the link', async () => {
    const result = await scorer(
      fakeContext({
        psql: fixed,
        files,
        toolCalls: [
          shellCall(
            'supabase db query --remote x -f scripts/list-profiles.sql',
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
