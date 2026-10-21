// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-cli-004-worktree-stacks
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  checkWorktrees,
  matchWorktrees,
  parseWorktreeList,
  pickRepo,
  repoDirFromGitEntry,
} from './worktrees.js';

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

describe('repoDirFromGitEntry', () => {
  it.each([
    ['./.git', '.'],
    ['.git', '.'],
    ['./repo/.git', './repo'],
    ['./feature-a/.git', './feature-a'],
    ['./nested/repo/.git/', './nested/repo'],
    ['/ws/.git', '/ws'],
    ['/ws/repo/.git', '/ws/repo'],
    ['/.git', '/'],
  ])('%s → %s', (entry, expected) => {
    expect(repoDirFromGitEntry(entry)).toBe(expected);
  });
});

describe('pickRepo', () => {
  const full = { repoDir: '/ws/b-repo', entries: parseWorktreeList(PORCELAIN) };
  const partial = {
    repoDir: '/ws/a-scratch',
    entries: parseWorktreeList(
      'worktree /ws/a-scratch\nbranch refs/heads/main\n'
    ),
  };

  it('prefers the repo whose worktrees match the expected names, whatever the order', () => {
    expect(pickRepo([partial, full], NAMES)).toBe(full);
    expect(pickRepo([full, partial], NAMES)).toBe(full);
  });

  it('prefers a complete match over a partial one', () => {
    const two = {
      repoDir: '/ws/a-two',
      entries: parseWorktreeList(PORCELAIN).filter(
        (e) => !e.path.endsWith('feature-c')
      ),
    };
    expect(pickRepo([two, full], NAMES)).toBe(full);
  });

  it('breaks ties by directory name', () => {
    const other = { ...full, repoDir: '/ws/a-repo' };
    expect(pickRepo([full, other], NAMES)).toBe(other);
    expect(pickRepo([other, full], NAMES)).toBe(other);
  });

  it('is undefined with no candidates', () => {
    expect(pickRepo([], NAMES)).toBeUndefined();
  });
});

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

function fakeCtx(options: {
  gitEntries: string[];
  repos: Record<string, string>;
  namedDirs?: Record<string, string>;
}): Pick<LocalStackEvalContext, 'exec'> {
  return {
    exec: async (command: string) => {
      if (command.includes('-name .git')) {
        return commandResult(options.gitEntries.join('\n'));
      }
      const list = command.match(/^cd '([^']+)' && git worktree list/);
      if (list) {
        const out = options.repos[list[1]];
        return out === undefined
          ? commandResult('fatal: not a git repository', false)
          : commandResult(out);
      }
      const named = command.match(/-name '([^']+)'/);
      if (named) return commandResult(options.namedDirs?.[named[1]] ?? '');
      return commandResult('', false);
    },
  };
}

describe('checkWorktrees', () => {
  it('uses the repo whose worktrees match, not the first .git find reports', async () => {
    const result = await checkWorktrees(
      fakeCtx({
        gitEntries: ['/ws/aaa-scratch/.git', '/ws/repo/.git'],
        repos: {
          '/ws/aaa-scratch':
            'worktree /ws/aaa-scratch\nbranch refs/heads/main\n',
          '/ws/repo': PORCELAIN,
        },
      })
    );
    expect(result.check.passed).toBe(true);
    expect(result.dirs).toEqual({
      'feature-a': '/tmp/sandbox-1234/feature-a',
      'feature-b': '/tmp/sandbox-1234/feature-b',
      'feature-c': '/tmp/sandbox-1234/feature-c',
    });
  });

  it('fails with the problems git reports, keeping the dirs it found', async () => {
    const result = await checkWorktrees(
      fakeCtx({
        gitEntries: ['/ws/repo/.git'],
        repos: {
          '/ws/repo': PORCELAIN.replace(
            /\nworktree [^\n]*feature-c[^]*$/,
            '\n'
          ),
        },
        namedDirs: { 'feature-c': '/ws/feature-c' },
      })
    );
    expect(result.check.passed).toBe(false);
    expect(result.check.notes).toContain('no worktree named feature-c');
    expect(result.dirs['feature-c']).toBe('/ws/feature-c');
  });

  it('fails when the workspace has no repo', async () => {
    const result = await checkWorktrees(fakeCtx({ gitEntries: [], repos: {} }));
    expect(result.check).toMatchObject({
      passed: false,
      notes: 'no git repository in the workspace',
    });
  });

  it('reports git failures when no repo could be listed', async () => {
    const result = await checkWorktrees(
      fakeCtx({ gitEntries: ['/ws/repo/.git'], repos: {} })
    );
    expect(result.check.passed).toBe(false);
    expect(result.check.notes).toContain(
      'git worktree list failed in /ws/repo'
    );
  });
});
