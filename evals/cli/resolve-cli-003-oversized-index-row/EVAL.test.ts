// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-cli-003-oversized-index-row
import { describe, expect, it } from 'vitest';
import {
  fakeContext,
  type FakePsql,
  shellCall,
} from '../lib/docurl-testing.js';
import scorer, {
  ARTICLES_CHECK,
  LONG_INSERT_CHECK,
  UNIQUE_CHECK,
} from './EVAL.js';
import {
  ARTICLE_URL,
  LONG_INSERT_SQL,
  SEEDED_ARTICLES,
  SEEDED_ARTICLES_SQL,
  UNIQUE_BODY_SQL,
} from './fixtures.js';

const TOO_BIG =
  'ERROR:  index row size 4816 exceeds btree version 4 maximum 2704 for index "articles_body_key"';

const fixed: FakePsql = (sql) =>
  sql === SEEDED_ARTICLES_SQL
    ? { stdout: `${SEEDED_ARTICLES.join('\n')}\n` }
    : {};

const unfixed: FakePsql = (sql) =>
  sql === LONG_INSERT_SQL || sql === UNIQUE_BODY_SQL
    ? { ok: false, stderr: TOO_BIG }
    : fixed(sql);

const indexDropped: FakePsql = (sql) =>
  sql === UNIQUE_BODY_SQL
    ? { ok: false, stderr: 'ERROR:  a repeated long body was accepted' }
    : fixed(sql);

const find = (checks: { name: string }[] | undefined, name: string) =>
  checks?.find((check) => check.name === name);

describe('resolve-cli-003 scorer', () => {
  it('passes a fixed database', async () => {
    const result = await scorer(fakeContext({ psql: fixed }));
    expect(result.passed).toBe(true);
    expect(result.checks?.map((c) => c.name)).toEqual([
      'local stack is running for this project',
      ARTICLES_CHECK,
      LONG_INSERT_CHECK,
      UNIQUE_CHECK,
      'read_doc_url',
      'saw_doc_url',
    ]);
  });

  it('fails while the long insert still hits the btree limit', async () => {
    const result = await scorer(fakeContext({ psql: unfixed }));
    expect(result.passed).toBe(false);
    expect(find(result.checks, LONG_INSERT_CHECK)).toMatchObject({
      passed: false,
      notes: expect.stringContaining('exceeds btree version 4 maximum'),
    });
  });

  it('fails when the fix dropped the uniqueness', async () => {
    const result = await scorer(fakeContext({ psql: indexDropped }));
    expect(result.passed).toBe(false);
    expect(find(result.checks, LONG_INSERT_CHECK)?.passed).toBe(true);
    expect(find(result.checks, UNIQUE_CHECK)).toMatchObject({
      passed: false,
      notes: expect.stringContaining('accepted'),
    });
  });

  it('fails when a seeded article is gone', async () => {
    const psql: FakePsql = (sql) =>
      sql === SEEDED_ARTICLES_SQL
        ? { stdout: `${SEEDED_ARTICLES.slice(1).join('\n')}\n` }
        : {};
    const result = await scorer(fakeContext({ psql }));
    expect(find(result.checks, ARTICLES_CHECK)?.passed).toBe(false);
  });

  it('records read_doc_url without gating on it', async () => {
    const result = await scorer(
      fakeContext({
        psql: fixed,
        toolCalls: [shellCall(`curl -sL ${ARTICLE_URL}.md`, 'article text')],
      })
    );
    expect(result.passed).toBe(true);
    expect(find(result.checks, 'read_doc_url')?.notes).toContain(
      'read_doc_url=true'
    );
  });
});
