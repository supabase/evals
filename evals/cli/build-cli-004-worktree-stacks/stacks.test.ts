// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-cli-004-worktree-stacks
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import type { StackProbe } from '../lib/stack.js';
import {
  checkDistinctStacks,
  endpointKey,
  resolveWorktreeStacks,
  type WorktreeStacks,
} from './stacks.js';

const DIRS = {
  'feature-a': '/ws/feature-a',
  'feature-b': '/ws/feature-b',
  'feature-c': '/ws/feature-c',
};

function url(port: number): string {
  return `postgresql://postgres:secret@127.0.0.1:${port}/postgres`;
}

function stack(port: number): StackProbe {
  return { ok: true, backend: 'managed', dbUrl: url(port), runtime: 'native' };
}

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

type FakeStack = { dir: string; name: string; port: number; home?: string };

/** Stacks answer `stack list` and `stack status` from their project dir, under the home they were started with. */
function fakeCtx(stacks: FakeStack[]): Pick<LocalStackEvalContext, 'exec'> {
  return {
    exec: async (command: string) => {
      const dir = command.match(/^cd '([^']+)'/)?.[1];
      const home = command.match(/SUPABASE_HOME='([^']+)'/)?.[1];
      const visible = stacks.filter((s) => s.home === home && s.dir === dir);
      if (command.includes('supabase stack list')) {
        const listed = stacks.filter((s) => s.home === home);
        return commandResult(
          `${dir}\n[task] listing {stacks}\n${JSON.stringify({
            stacks: listed.map((s) => ({
              name: s.name,
              project_root: s.dir,
              owner: 'reachable',
            })),
          })}`
        );
      }
      const named = command.match(/--stack '([^']+)'/)?.[1];
      const found = visible.find((s) => s.name === (named ?? 'default'));
      if (command.includes('stack status') && found) {
        return command.includes('--env')
          ? commandResult(
              `[task] starting {stack}\n${JSON.stringify({ DB_URL: url(found.port) })}`
            )
          : commandResult(JSON.stringify({ runtime: { kind: 'native' } }));
      }
      return commandResult('', false);
    },
  };
}

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

describe('checkDistinctStacks', () => {
  it('passes with three distinct endpoints', () => {
    const result = checkDistinctStacks({
      'feature-a': stack(1),
      'feature-b': stack(2),
      'feature-c': stack(3),
    });
    expect(result.passed).toBe(true);
    expect(result.notes).toContain('feature-b: 127.0.0.1:2 (managed/native)');
  });

  it('fails when two worktrees share an endpoint', () => {
    const result = checkDistinctStacks({
      'feature-a': stack(1),
      'feature-b': stack(1),
      'feature-c': stack(3),
    });
    expect(result.passed).toBe(false);
  });

  it('fails and names the worktree whose stack did not resolve, without leaking credentials', () => {
    const result = checkDistinctStacks({
      'feature-a': stack(1),
      'feature-b': { ok: false, notes: 'No managed stack exists' },
      'feature-c': stack(3),
    });
    expect(result).toMatchObject({
      passed: false,
      notes: 'feature-b: No managed stack exists',
    });
  });
});

describe('resolveWorktreeStacks', () => {
  it('resolves named managed stacks started with --stack <name> in each worktree', async () => {
    const ctx = fakeCtx([
      { dir: DIRS['feature-a'], name: 'feature-a', port: 1 },
      { dir: DIRS['feature-b'], name: 'b-stack', port: 2 },
      { dir: DIRS['feature-c'], name: 'feature-c', port: 3 },
    ]);
    const stacks = await resolveWorktreeStacks(ctx, DIRS, []);
    expect(Object.values(stacks).map((s) => s.ok && s.backend)).toEqual([
      'managed-named',
      'managed-named',
      'managed-named',
    ]);
    expect(checkDistinctStacks(stacks).passed).toBe(true);
  });

  it('resolves a stack started under a per-worktree SUPABASE_HOME', async () => {
    const ctx = fakeCtx([
      { dir: DIRS['feature-a'], name: 'default', port: 1, home: '/h/a' },
      { dir: DIRS['feature-b'], name: 'default', port: 2, home: '/h/b' },
      { dir: DIRS['feature-c'], name: 'default', port: 3, home: '/h/c' },
    ]);
    const invocations = findSupabaseInvocations(
      (['a', 'b', 'c'] as const).map((id) => ({
        command: `SUPABASE_HOME=/h/${id} SUPABASE_EXPERIMENTAL_STACK=1 supabase stack start --stack default`,
        cwd: `/ws/feature-${id}`,
      }))
    );
    const stacks = await resolveWorktreeStacks(ctx, DIRS, invocations);
    expect(stacks['feature-b']).toMatchObject({
      ok: true,
      relocatedHome: '/h/b',
    });
    expect(checkDistinctStacks(stacks).passed).toBe(true);
  });

  it("does not credit a --stack name run in another worktree's directory to the named worktree", async () => {
    const ctx = fakeCtx([
      { dir: DIRS['feature-a'], name: 'default', port: 1, home: '/h/wrong' },
    ]);
    const invocations = findSupabaseInvocations([
      {
        command:
          'SUPABASE_HOME=/h/wrong SUPABASE_EXPERIMENTAL_STACK=1 supabase stack start --stack feature-a',
        cwd: '/ws/feature-b',
      },
    ]);
    const stacks: WorktreeStacks = await resolveWorktreeStacks(
      ctx,
      { 'feature-a': DIRS['feature-a'] },
      invocations
    );
    expect(stacks['feature-a'].ok).toBe(false);
  });

  it('fails a worktree whose directory is unknown', async () => {
    const stacks = await resolveWorktreeStacks(fakeCtx([]), {}, []);
    expect(stacks['feature-a']).toEqual({
      ok: false,
      notes: 'worktree directory not found',
    });
  });
});
