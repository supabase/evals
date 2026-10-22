// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-001-slow-query
import { execFileSync } from 'node:child_process';
import type { CommandResult } from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import { queryDatabase } from './psql.js';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: DB_URL,
  runtime: 'native',
};

const result = (stdout: string): CommandResult => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr: '',
});

const argvOf = (command: string): string[] =>
  execFileSync('sh', ['-c', `psql() { printf '%s\\0' "$@"; }\n${command}`], {
    encoding: 'utf8',
  })
    .split('\0')
    .slice(0, -1);

describe('queryDatabase', () => {
  it.each([
    ['a placeholder and a double quote', `select '$1' as "x"`],
    ['single quotes', "select 'it''s' as x"],
    ['a backslash before a dollar', "select '\\$1' as x"],
  ])('hands psql the SQL unchanged when it holds %s', async (_label, sql) => {
    const exec = vi.fn(async () => result(''));
    await queryDatabase({ exec }, STACK, sql, () => ({ ok: true }));
    expect(argvOf(exec.mock.calls[0][0])).toEqual([DB_URL, '-XtAc', sql]);
  });
});
