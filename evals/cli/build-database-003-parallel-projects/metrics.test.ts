// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/build-database-003-parallel-projects
import type {
  CommandResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { checkMetrics } from './metrics.js';
import type { ClientStacks } from './stacks.js';

const DB_A = 'postgresql://postgres:secret@127.0.0.1:54322/postgres';
const DB_B = 'postgresql://postgres:secret@127.0.0.1:54332/postgres';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.0.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

function fakeCtx(
  postmasterStartMs: Record<string, number>
): Pick<LocalStackEvalContext, 'exec'> {
  return {
    exec: async (command: string) => {
      if (command === 'supabase --version') return commandResult('2.0.0\n');
      const psql = command.match(/^psql '([^']+)' .*pg_postmaster_start_time/);
      const ms = psql ? postmasterStartMs[psql[1]] : undefined;
      return ms === undefined
        ? commandResult('', false)
        : commandResult(`${ms}\n`);
    },
  };
}

const STACKS: ClientStacks = {
  'client-a': {
    ok: true,
    backend: 'managed',
    dbUrl: DB_A,
    apiUrl: 'http://127.0.0.1:54321',
    runtime: 'native',
  },
  'client-b': {
    ok: true,
    backend: 'legacy',
    dbUrl: DB_B,
    runtime: 'docker',
  },
};

describe('checkMetrics', () => {
  it('reports per-project backend, runtime, ports, and postmaster start', async () => {
    const result = await checkMetrics(
      fakeCtx({ [DB_A]: 5_000, [DB_B]: 7_000 }),
      MARKER,
      ['sudo dockerd'],
      ['sudo dockerd', 'unset DOCKER_HOST'],
      STACKS
    );
    expect(result.passed).toBe(true);
    expect(JSON.parse(result.notes as string)).toEqual({
      cliVersion: '2.0.0',
      projects: {
        'client-a': {
          backend: 'managed',
          runtime: 'native',
          dbPort: 54322,
          apiPort: 54321,
          postmasterStartMs: 5_000,
        },
        'client-b': {
          backend: 'legacy',
          runtime: 'docker',
          dbPort: 54332,
          apiPort: null,
          postmasterStartMs: 7_000,
        },
      },
      timeToReadyMs: 6_000,
      cliDetours: 1,
      clearedDockerHost: 1,
      rawDockerSocketProbes: 0,
      channel: 'beta',
    });
  });

  it('reports a null timeToReadyMs and "none" when a stack never resolved', async () => {
    const result = await checkMetrics(
      fakeCtx({ [DB_A]: 5_000 }),
      MARKER,
      [],
      [],
      {
        'client-a': STACKS['client-a'],
        'client-b': { ok: false, notes: 'no stack' },
      }
    );
    const metrics = JSON.parse(result.notes as string);
    expect(result.passed).toBe(true);
    expect(metrics.timeToReadyMs).toBeNull();
    expect(metrics.projects['client-b']).toEqual({
      backend: 'none',
      runtime: 'none',
      dbPort: null,
      apiPort: null,
      postmasterStartMs: null,
    });
  });

  it('reports channel "pinned" when the environment marker is missing', async () => {
    const result = await checkMetrics(fakeCtx({}), undefined, [], [], STACKS);
    expect(JSON.parse(result.notes as string).channel).toBe('pinned');
  });
});
