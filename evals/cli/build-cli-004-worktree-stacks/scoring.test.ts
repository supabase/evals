// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-cli-004-worktree-stacks
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  checkMetrics,
  countSupabaseStarts,
  endpointKey,
  matchWorktrees,
  migrationCreatesTable,
  parseJsonObject,
  parseWorktreeList,
  repoDirFromGitEntry,
} from './scoring.js';

// Captured from `git worktree list --porcelain` on a repo with three linked
// worktrees (paths shortened).
const PORCELAIN = `worktree /tmp/sandbox-1234/repo
HEAD 14b5b37788863c554f10ecf818490f56f2d51e4b
branch refs/heads/main

worktree /tmp/sandbox-1234/feature-a
HEAD 14b5b37788863c554f10ecf818490f56f2d51e4b
branch refs/heads/feature-a

worktree /tmp/sandbox-1234/feature-b
HEAD 14b5b37788863c554f10ecf818490f56f2d51e4b
branch refs/heads/feature-b

worktree /tmp/sandbox-1234/feature-c
HEAD 14b5b37788863c554f10ecf818490f56f2d51e4b
branch refs/heads/feature-c
`;

const NAMES = ['feature-a', 'feature-b', 'feature-c'];

describe('parseWorktreeList', () => {
  it('parses one entry per worktree with its branch', () => {
    const entries = parseWorktreeList(PORCELAIN);
    expect(entries.map((e) => [e.path, e.branch])).toEqual([
      ['/tmp/sandbox-1234/repo', 'refs/heads/main'],
      ['/tmp/sandbox-1234/feature-a', 'refs/heads/feature-a'],
      ['/tmp/sandbox-1234/feature-b', 'refs/heads/feature-b'],
      ['/tmp/sandbox-1234/feature-c', 'refs/heads/feature-c'],
    ]);
    expect(entries.every((e) => !e.detached && !e.bare)).toBe(true);
  });

  it('marks detached and bare worktrees', () => {
    const entries = parseWorktreeList(
      'worktree /r\nbare\n\nworktree /r/x\nHEAD abc\ndetached\n'
    );
    expect(entries[0]).toMatchObject({ path: '/r', bare: true });
    expect(entries[1]).toMatchObject({ path: '/r/x', detached: true });
    expect(entries[1]?.branch).toBeUndefined();
  });

  it('returns nothing for empty or non-porcelain output', () => {
    expect(parseWorktreeList('')).toEqual([]);
    expect(parseWorktreeList('fatal: not a git repository')).toEqual([]);
  });
});

describe('matchWorktrees', () => {
  it('accepts three worktrees on three distinct branches', () => {
    const { matched, problems } = matchWorktrees(
      parseWorktreeList(PORCELAIN),
      NAMES
    );
    expect(problems).toEqual([]);
    expect(matched['feature-b']?.branch).toBe('refs/heads/feature-b');
  });

  it('reports a missing worktree', () => {
    const entries = parseWorktreeList(PORCELAIN).filter(
      (e) => !e.path.endsWith('feature-c')
    );
    expect(matchWorktrees(entries, NAMES).problems).toEqual([
      'no worktree named feature-c',
    ]);
  });

  it('rejects two worktrees on the same branch', () => {
    const entries = parseWorktreeList(PORCELAIN).map((e) =>
      e.path.endsWith('feature-c')
        ? { ...e, branch: 'refs/heads/feature-b' }
        : e
    );
    expect(matchWorktrees(entries, NAMES).problems).toEqual([
      'more than one worktree is on refs/heads/feature-b',
    ]);
  });

  it('rejects a detached worktree', () => {
    const entries = parseWorktreeList(PORCELAIN).map((e) =>
      e.path.endsWith('feature-a')
        ? { ...e, branch: undefined, detached: true }
        : e
    );
    expect(matchWorktrees(entries, NAMES).problems).toEqual([
      'feature-a is not checked out on a branch',
    ]);
  });

  it('matches by basename, so a nested repo layout still works', () => {
    const entries = parseWorktreeList(
      PORCELAIN.replaceAll(
        '/tmp/sandbox-1234/',
        '/tmp/sandbox-1234/repo/.worktrees/'
      )
    );
    expect(matchWorktrees(entries, NAMES).problems).toEqual([]);
  });
});

describe('parseJsonObject', () => {
  it('skips the CLI task progress lines around the JSON payload', () => {
    const stdout = `[task] start: Starting local Supabase stack...
[task] done: Stack is ready.
{"id":"963a","lifecycle":"running","runtime":{"kind":"native"}}
`;
    expect(parseJsonObject(stdout)).toEqual({
      id: '963a',
      lifecycle: 'running',
      runtime: { kind: 'native' },
    });
  });

  it('returns the error envelope the managed backend prints for a missing stack', () => {
    const stdout =
      '{"_tag":"Error","error":{"code":"ExperimentalStackStatusError","message":"No managed stack exists for the selected project."}}';
    expect(parseJsonObject(stdout)?._tag).toBe('Error');
  });

  it('is undefined for non-JSON output', () => {
    expect(parseJsonObject('')).toBeUndefined();
    expect(
      parseJsonObject('The legacy -o/--output flag is not supported here')
    ).toBeUndefined();
    expect(parseJsonObject('{not json}')).toBeUndefined();
  });
});

describe('endpointKey', () => {
  it('reduces a connection URL to host:port, ignoring credentials', () => {
    expect(
      endpointKey(
        'postgresql://postgres:ed941619-34a3-4772-bf78-9d9c855ecb64@127.0.0.1:25304/postgres'
      )
    ).toBe('127.0.0.1:25304');
    expect(
      endpointKey('postgresql://postgres:postgres@127.0.0.1:54322/postgres')
    ).toBe('127.0.0.1:54322');
  });

  it('tells two stacks with different passwords but the same port apart as the same endpoint', () => {
    const a = endpointKey('postgresql://postgres:aaa@127.0.0.1:54322/postgres');
    const b = endpointKey('postgresql://postgres:bbb@127.0.0.1:54322/postgres');
    expect(a).toBe(b);
  });

  it('is undefined for garbage', () => {
    expect(endpointKey('not a url')).toBeUndefined();
  });
});

describe('migrationCreatesTable', () => {
  it.each([
    'create table widgets (id serial primary key);',
    'CREATE TABLE IF NOT EXISTS public.widgets (id int);',
    'create table "public"."widgets" ("id" int);',
    'create table\n  public.widgets (\n  id int\n);',
  ])('matches: %s', (sql) => {
    expect(migrationCreatesTable(sql, 'widgets')).toBe(true);
  });

  it.each([
    'create table gadgets (id int);',
    'create table widgets_archive (id int);',
    "insert into widgets values ('w1');",
  ])('does not match: %s', (sql) => {
    expect(migrationCreatesTable(sql, 'widgets')).toBe(false);
  });
});

describe('countSupabaseStarts', () => {
  it('counts legacy and managed start invocations across commands', () => {
    expect(
      countSupabaseStarts([
        'cd feature-a && supabase start',
        `bash -lc 'cd feature-b && SUPABASE_EXPERIMENTAL_STACK=1 supabase stack start --runtime native'`,
        'supabase status',
        'cd feature-c && supabase start -x studio && supabase start',
      ])
    ).toBe(4);
  });

  it('ignores unrelated mentions', () => {
    expect(
      countSupabaseStarts(['echo "run supabase start later"', 'git status'])
    ).toBe(1);
  });
});

describe('checkMetrics', () => {
  it('reports channel "pinned" when the session recorded no environment marker', async () => {
    const notExecuted: CommandResult = {
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: '',
    };
    const ctx = {
      exec: async () => notExecuted,
      toolCalls: [],
      environmentMarker: async () => undefined,
    } as unknown as LocalStackEvalContext;

    const result = await checkMetrics(ctx, {});
    expect(result.passed).toBe(true);
    expect(JSON.parse(result.notes ?? '{}')).toMatchObject({
      channel: 'pinned',
    });
  });
});

describe('repoDirFromGitEntry', () => {
  it.each([
    ['./.git', '.'],
    ['.git', '.'],
    ['./repo/.git', './repo'],
    ['./feature-a/.git', './feature-a'],
    ['./nested/repo/.git/', './nested/repo'],
  ])('%s → %s', (entry, expected) => {
    expect(repoDirFromGitEntry(entry)).toBe(expected);
  });
});
