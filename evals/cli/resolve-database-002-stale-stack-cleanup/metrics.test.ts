// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/resolve-database-002-stale-stack-cleanup
import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  findSupabaseInvocations,
  type CommandEntry,
} from '../lib/cli-invocations.js';
import type { StackProbe } from '../lib/stack.js';
import { checkMetrics } from './metrics.js';

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

const stack = (port: number, relocatedHome?: string): StackProbe => ({
  ok: true,
  backend: 'managed-named',
  dbUrl: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
  apiUrl: `http://127.0.0.1:${port - 1}`,
  runtime: 'native',
  ...(relocatedHome === undefined ? {} : { relocatedHome }),
});
const NONE: StackProbe = { ok: false, notes: 'no stack' };

const ctx = {
  exec: async (command: string) =>
    command === 'supabase --version'
      ? commandResult('2.118.0\n')
      : commandResult('', false),
} as unknown as Pick<LocalStackEvalContext, 'exec'>;
const NO_POSTMASTER = { 'checkout-service': null, 'payments-api': null };

describe('checkMetrics', () => {
  it('reports per-service backend, ports and postmaster start for survivors', async () => {
    const result = await checkMetrics(
      ctx,
      undefined,
      ['unset DOCKER_HOST && supabase start', 'sudo dockerd'],
      findSupabaseInvocations(['unset DOCKER_HOST && supabase start']),
      ['sudo dockerd'],
      { ok: true, stacks: [{ name: 'checkout-service' }] },
      {
        'checkout-service': stack(54322, '/sandbox/.supabase-home'),
        'payments-api': stack(54422),
        'legacy-import': stack(54522),
      },
      { 'checkout-service': 2000, 'payments-api': 1000 },
      ['npx --yes supabase@2.120.0']
    );
    expect(result.passed).toBe(true);
    expect(JSON.parse(result.notes as string)).toEqual({
      cliVersion: '2.118.0',
      cliOverride: ['npx --yes supabase@2.120.0'],
      channel: 'pinned',
      services: {
        'checkout-service': {
          backend: 'managed-named',
          runtime: 'native',
          dbPort: 54322,
          apiPort: 54321,
          postmasterStartMs: 2000,
          relocatedHome: '/sandbox/.supabase-home',
        },
        'payments-api': {
          backend: 'managed-named',
          runtime: 'native',
          dbPort: 54422,
          apiPort: 54421,
          postmasterStartMs: 1000,
          relocatedHome: null,
        },
        'legacy-import': {
          backend: 'managed-named',
          runtime: 'native',
          dbPort: 54522,
          apiPort: 54521,
          postmasterStartMs: null,
          relocatedHome: null,
        },
      },
      attemptedStart: {
        'checkout-service': false,
        'payments-api': false,
        'legacy-import': false,
      },
      attemptedAnyStart: true,
      legacyTeardown: 'none',
      setupCompletedAt: null,
      evidence: {
        checkoutRestarted: 'unavailable',
        paymentsUntouched: 'unavailable',
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
      ctx,
      {
        runtime: 'local-stack',
        channel: 'beta',
        cliVersion: '2.118.0',
        docker: 'absent',
        sessionStartedMs: 0,
      },
      [],
      [],
      [],
      { ok: false, unsupported: true, notes: 'unknown command' },
      { 'checkout-service': NONE, 'payments-api': NONE, 'legacy-import': NONE },
      NO_POSTMASTER
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
      relocatedHome: null,
    });
    expect(metrics.cliOverride).toEqual([]);
    expect(metrics.checkoutPostmasterNewerThanPayments).toBe(null);
    expect(metrics.stackListAvailable).toBe(false);
    expect(metrics.stackCount).toBe(null);
  });

  async function attemptedStarts(entries: (string | CommandEntry)[]) {
    const result = await checkMetrics(
      ctx,
      undefined,
      entries.map((entry) =>
        typeof entry === 'string' ? entry : entry.command
      ),
      findSupabaseInvocations(entries),
      [],
      { ok: false, unsupported: true, notes: 'unknown command' },
      { 'checkout-service': NONE, 'payments-api': NONE, 'legacy-import': NONE },
      NO_POSTMASTER
    );
    const { attemptedStart, attemptedAnyStart } = JSON.parse(
      result.notes as string
    );
    return { attemptedStart, attemptedAnyStart };
  }

  it('reports no start attempts when no start was invoked', async () => {
    expect(await attemptedStarts(['ls', 'supabase --version'])).toEqual({
      attemptedStart: {
        'checkout-service': false,
        'payments-api': false,
        'legacy-import': false,
      },
      attemptedAnyStart: false,
    });
  });

  it('attributes a --workdir start to that service only', async () => {
    expect(
      await attemptedStarts(['supabase start --workdir checkout-service'])
    ).toEqual({
      attemptedStart: {
        'checkout-service': true,
        'payments-api': false,
        'legacy-import': false,
      },
      attemptedAnyStart: true,
    });
  });

  it('attributes a loop start with an unresolved target to every service', async () => {
    expect(
      await attemptedStarts([
        'for s in checkout-service payments-api legacy-import; do (cd "$s" && supabase start); done',
      ])
    ).toEqual({
      attemptedStart: {
        'checkout-service': true,
        'payments-api': true,
        'legacy-import': true,
      },
      attemptedAnyStart: true,
    });
  });

  it('attributes bare starts to each service by per-call cwd', async () => {
    expect(
      await attemptedStarts(
        ['checkout-service', 'payments-api', 'legacy-import'].map(
          (service) => ({
            command: 'supabase start',
            cwd: `/tmp/sandbox-x/${service}`,
          })
        )
      )
    ).toEqual({
      attemptedStart: {
        'checkout-service': true,
        'payments-api': true,
        'legacy-import': true,
      },
      attemptedAnyStart: true,
    });
  });

  it('does not count supabase start --help as a start', async () => {
    expect(
      (await attemptedStarts(['supabase start --help'])).attemptedAnyStart
    ).toBe(false);
  });

  it('does not count an echoed start', async () => {
    expect(
      await attemptedStarts(['echo "cd checkout-service && supabase start"'])
    ).toEqual({
      attemptedStart: {
        'checkout-service': false,
        'payments-api': false,
        'legacy-import': false,
      },
      attemptedAnyStart: false,
    });
  });

  it('reports when setup completed and which evidence decided each check', async () => {
    const T = Date.parse('2026-10-01T11:50:42.000Z');
    const entries: CommandEntry[] = [
      'checkout-service',
      'payments-api',
      'legacy-import',
    ].map((service, i) => ({
      command: `supabase start --workdir ${service}`,
      at: T - (2 - i) * 10_000,
    }));
    const result = await checkMetrics(
      ctx,
      undefined,
      entries.map((entry) => entry.command),
      findSupabaseInvocations(entries),
      [],
      { ok: false, unsupported: true, notes: 'unknown command' },
      {
        'checkout-service': stack(54322),
        'payments-api': stack(54422),
        'legacy-import': NONE,
      },
      { 'checkout-service': T + 60_000, 'payments-api': null }
    );
    const { setupCompletedAt, evidence } = JSON.parse(result.notes as string);
    expect(setupCompletedAt).toBe(T);
    expect(evidence).toEqual({
      checkoutRestarted: 'state',
      paymentsUntouched: 'commands',
    });
  });

  it('reports how the legacy-import teardown went', async () => {
    const legacyTeardown = async (stop: { failed?: boolean }) => {
      const invocations = findSupabaseInvocations([
        'cd legacy-import && supabase start',
        'cd legacy-import && supabase stop --no-backup',
      ]).map((inv) => (inv.argv.includes('stop') ? { ...inv, ...stop } : inv));
      const result = await checkMetrics(
        ctx,
        undefined,
        [],
        invocations,
        [],
        { ok: false, unsupported: true, notes: 'unknown command' },
        {
          'checkout-service': NONE,
          'payments-api': NONE,
          'legacy-import': NONE,
        },
        NO_POSTMASTER
      );
      return JSON.parse(result.notes as string).legacyTeardown;
    };
    expect(await legacyTeardown({})).toBe('succeeded');
    expect(await legacyTeardown({ failed: true })).toBe('failed');
  });
});
