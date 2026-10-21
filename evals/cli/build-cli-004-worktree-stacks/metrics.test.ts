// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-cli-004-worktree-stacks
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { checkMetrics, countStarts } from './metrics.js';
import type { WorktreeStacks } from './stacks.js';

const NO_STACKS: WorktreeStacks = {
  'feature-a': { ok: false, notes: 'x' },
  'feature-b': { ok: false, notes: 'x' },
  'feature-c': { ok: false, notes: 'x' },
};

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

describe('countStarts', () => {
  it('counts executed legacy and managed starts separately', () => {
    const invocations = findSupabaseInvocations([
      'cd feature-a && supabase start',
      `bash -lc 'cd feature-b && SUPABASE_EXPERIMENTAL_STACK=1 supabase stack start --runtime native'`,
      'supabase status',
      'cd feature-c && supabase start -x studio && supabase start',
    ]);
    expect(countStarts(invocations)).toEqual({
      stackStart: 1,
      legacyStart: 3,
      experimentalStack: true,
    });
  });

  it('ignores echoed, committed and unrelated mentions', () => {
    const invocations = findSupabaseInvocations([
      'echo "run supabase start later"',
      'git commit -m "supabase stack start"',
      'git status',
    ]);
    expect(countStarts(invocations)).toEqual({
      stackStart: 0,
      legacyStart: 0,
      experimentalStack: false,
    });
  });

  it('records the feature flag only when a start enabled it', () => {
    expect(
      countStarts(
        findSupabaseInvocations([
          'SUPABASE_EXPERIMENTAL_STACK=0 supabase start',
        ])
      ).experimentalStack
    ).toBe(false);
    expect(
      countStarts(
        findSupabaseInvocations([
          'export SUPABASE_EXPERIMENTAL_STACK=1 && supabase stack start',
        ])
      ).experimentalStack
    ).toBe(true);
  });
});

describe('checkMetrics', () => {
  const failing = {
    exec: async () => commandResult('', false),
  } as unknown as LocalStackEvalContext;

  it('reports channel "pinned" when the session recorded no environment marker', async () => {
    const result = await checkMetrics(failing, undefined, [], NO_STACKS);
    expect(result.passed).toBe(true);
    expect(JSON.parse(result.notes ?? '{}')).toMatchObject({
      channel: 'pinned',
      stacksRunning: 0,
      fleetWallClockMs: null,
      stackStartInvocations: 0,
      legacyStartInvocations: 0,
      experimentalStack: false,
    });
  });

  it('reports per-worktree backend, endpoint and relocated home, and the fleet wall-clock', async () => {
    const ctx = {
      exec: async (command: string) =>
        command.includes('pg_postmaster_start_time')
          ? commandResult('1700000010000\n')
          : commandResult('', false),
    } as unknown as LocalStackEvalContext;
    const stack = (port: number, relocatedHome?: string) =>
      ({
        ok: true,
        backend: 'managed-named',
        dbUrl: `postgresql://postgres:secret@127.0.0.1:${port}/postgres`,
        runtime: 'native',
        ...(relocatedHome === undefined ? {} : { relocatedHome }),
      }) as const;
    const result = await checkMetrics(
      ctx,
      {
        runtime: 'local-stack',
        channel: 'beta',
        cliVersion: '2.121.0',
        docker: 'absent',
        sessionStartedMs: 1700000000000,
      },
      [],
      {
        'feature-a': stack(1),
        'feature-b': stack(2, '/h/b'),
        'feature-c': stack(3),
      }
    );
    const metrics = JSON.parse(result.notes ?? '{}');
    expect(metrics).toMatchObject({
      channel: 'beta',
      stacksRunning: 3,
      fleetWallClockMs: 10000,
    });
    expect(metrics.worktrees['feature-b']).toMatchObject({
      backend: 'managed-named',
      endpoint: '127.0.0.1:2',
      relocatedHome: '/h/b',
    });
    expect(result.notes).not.toContain('secret');
  });
});
