// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/resolve-database-002-stale-stack-cleanup
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import type { StackProbe } from '../lib/stack.js';
import { checkMetrics } from './metrics.js';

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

const stack = (port: number): StackProbe => ({
  ok: true,
  backend: 'managed-named',
  dbUrl: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
  apiUrl: `http://127.0.0.1:${port - 1}`,
  runtime: 'native',
});
const NONE: StackProbe = { ok: false, notes: 'no stack' };

function fakeCtx(postmasterMs: Record<number, number>) {
  return {
    exec: async (command: string) => {
      if (command === 'supabase --version') return commandResult('2.118.0\n');
      const port = Number(command.match(/127\.0\.0\.1:(\d+)/)?.[1]);
      return postmasterMs[port] === undefined
        ? commandResult('', false)
        : commandResult(`${postmasterMs[port]}\n`);
    },
  } as unknown as Pick<LocalStackEvalContext, 'exec'>;
}

describe('checkMetrics', () => {
  it('reports per-service backend, ports and postmaster start for survivors', async () => {
    const result = await checkMetrics(
      fakeCtx({ 54322: 2000, 54422: 1000, 54522: 500 }),
      undefined,
      ['unset DOCKER_HOST && supabase start', 'sudo dockerd'],
      ['sudo dockerd'],
      { ok: true, stacks: [{ name: 'checkout-service' }] },
      {
        'checkout-service': stack(54322),
        'payments-api': stack(54422),
        'legacy-import': stack(54522),
      }
    );
    expect(result.passed).toBe(true);
    expect(JSON.parse(result.notes as string)).toEqual({
      cliVersion: '2.118.0',
      channel: 'pinned',
      services: {
        'checkout-service': {
          backend: 'managed-named',
          runtime: 'native',
          dbPort: 54322,
          apiPort: 54321,
          postmasterStartMs: 2000,
        },
        'payments-api': {
          backend: 'managed-named',
          runtime: 'native',
          dbPort: 54422,
          apiPort: 54421,
          postmasterStartMs: 1000,
        },
        'legacy-import': {
          backend: 'managed-named',
          runtime: 'native',
          dbPort: 54522,
          apiPort: 54521,
          postmasterStartMs: null,
        },
      },
      checkoutPostmasterNewerThanPayments: true,
      stackListAvailable: true,
      stackCount: 1,
      cliDetours: 1,
      clearedDockerHost: 1,
      rawDockerSocketProbes: 0,
    });
  });

  it('reports nulls when nothing resolved and the listing is unavailable', async () => {
    const result = await checkMetrics(
      fakeCtx({}),
      {
        runtime: 'local-stack',
        channel: 'beta',
        cliVersion: '2.118.0',
        docker: 'absent',
        sessionStartedMs: 0,
      },
      [],
      [],
      { ok: false, notes: 'unknown command' },
      { 'checkout-service': NONE, 'payments-api': NONE, 'legacy-import': NONE }
    );
    const metrics = JSON.parse(result.notes as string);
    expect(result.passed).toBe(true);
    expect(metrics.channel).toBe('beta');
    expect(metrics.services['checkout-service']).toEqual({
      backend: 'none',
      runtime: 'none',
      dbPort: null,
      apiPort: null,
      postmasterStartMs: null,
    });
    expect(metrics.checkoutPostmasterNewerThanPayments).toBe(null);
    expect(metrics.stackListAvailable).toBe(false);
    expect(metrics.stackCount).toBe(null);
  });
});
