// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-002-stack-lifecycle
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { checkMetrics, checkStackReady } from './stack.js';

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

describe('checkMetrics', () => {
  const fakeMetricsCtx = {
    exec: async () => commandResult('', false),
  } as unknown as LocalStackEvalContext;

  it('reports channel "pinned" when the environment marker is missing', async () => {
    const result = await checkMetrics(fakeMetricsCtx, undefined, [], [], {
      ok: false,
      notes: 'no stack',
    });
    expect(result.passed).toBe(true);
    expect(JSON.parse(result.notes as string).channel).toBe('pinned');
  });

  it('reports the marker channel when present', async () => {
    const result = await checkMetrics(
      fakeMetricsCtx,
      {
        runtime: 'local-stack',
        channel: 'beta',
        cliVersion: '2.0.0',
        docker: 'available',
        sessionStartedMs: 0,
      },
      [],
      [],
      { ok: false, notes: 'no stack' }
    );
    expect(JSON.parse(result.notes as string).channel).toBe('beta');
  });
});

describe('checkStackReady', () => {
  const stack = {
    ok: true,
    backend: 'managed',
    dbUrl: 'postgresql://x',
    runtime: 'native',
  } as const;

  it('prefixes a successful probe with "probe: "', async () => {
    const ctx = {
      exec: async () => commandResult('1\n'),
    } as unknown as LocalStackEvalContext;
    expect(await checkStackReady(ctx, stack)).toEqual({
      name: 'local stack reaches ready',
      passed: true,
      notes: 'probe: managed (native), select 1 ok',
    });
  });

  it('reports a failed probe without a prefix', async () => {
    const ctx = {
      exec: async () => commandResult('', false),
    } as unknown as LocalStackEvalContext;
    expect(await checkStackReady(ctx, stack)).toEqual({
      name: 'local stack reaches ready',
      passed: false,
      notes: 'exit 1: error',
    });
  });

  it('passes through the notes of an unresolved stack', async () => {
    const ctx = {} as LocalStackEvalContext;
    expect(
      await checkStackReady(ctx, { ok: false, notes: 'no stack' })
    ).toEqual({
      name: 'local stack reaches ready',
      passed: false,
      notes: 'no stack',
    });
  });
});
