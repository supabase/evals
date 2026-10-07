// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/resolve-database-003-docker-mode-unavailable
import type {
  CommandResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { extractCommandEntries, extractCommands } from '../lib/detours.js';
import type { StackProbe } from '../lib/stack.js';
import {
  checkMetrics,
  countDockerHostOverrides,
  countLeftoverDockerRegistrations,
  countManualStackStateEdits,
  type MetricsFacts,
} from './metrics.js';
import { startTimeline, type ActualRuntime } from './runtime.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

function call(
  command: string,
  options: { result?: string; error?: string } = {}
): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result: options.result,
    error: options.error,
    ts: 0,
  };
}

const NO_STACK: StackProbe = { ok: false, notes: 'no stack' };
const failingCtx: ExecContext = { exec: async () => commandResult('', false) };

function factsFor(
  calls: readonly ToolCallRecord[],
  stack: StackProbe = NO_STACK,
  actual: ActualRuntime = 'none'
): MetricsFacts {
  const invocations = findSupabaseInvocations(extractCommandEntries(calls));
  return {
    commands: extractCommands(calls),
    invocations,
    timeline: startTimeline(invocations, calls, stack),
    stack,
    actual,
  };
}

const metricsOf = async (
  ctx: ExecContext,
  facts: MetricsFacts,
  marker?: LocalStackEnvironmentMarker
) => {
  const result = await checkMetrics(ctx, marker, facts);
  expect(result).toMatchObject({ name: 'metrics', passed: true });
  return JSON.parse(result.notes as string);
};

const beta: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.119.0-beta.4',
  docker: 'no-daemon',
  sessionStartedMs: 1000,
};

describe('checkMetrics', () => {
  it('always passes and reports channel "pinned" when the marker is missing', async () => {
    const metrics = await metricsOf(failingCtx, factsFor([]));
    expect(metrics).toMatchObject({
      channel: 'pinned',
      resolvedRuntime: 'none',
      actualRuntime: 'none',
      startAttempts: [],
      managedStackReached: false,
      recoverySteps: null,
      timeToReadyMs: null,
    });
  });

  it('reports the marker channel and staged CLI version', async () => {
    const metrics = await metricsOf(failingCtx, factsFor([]), beta);
    expect(metrics).toMatchObject({
      channel: 'beta',
      cliVersion: '2.119.0-beta.4',
    });
  });

  it('keeps every other field when each probe throws', async () => {
    const throwing: ExecContext = {
      exec: async () => {
        throw new Error('boom');
      },
    };
    const calls = [call('supabase stack destroy --yes', { result: 'ok' })];
    const metrics = await metricsOf(
      throwing,
      factsFor(
        calls,
        { ok: true, backend: 'managed', dbUrl: 'x', runtime: 'native' },
        'native'
      )
    );
    expect(metrics).toMatchObject({
      resolvedRuntime: 'native',
      actualRuntime: 'native',
      timeToReadyMs: null,
      leftoverDockerRegistrations: null,
      stackDestroyUsed: true,
    });
  });

  it('computes timeToReadyMs from the postmaster start and the session start', async () => {
    const ctx: ExecContext = {
      exec: async (command) =>
        command.includes('pg_postmaster_start_time')
          ? commandResult('5000\n')
          : commandResult('', false),
    };
    const stack: StackProbe = {
      ok: true,
      backend: 'managed',
      dbUrl: 'postgresql://x',
      runtime: 'docker',
    };
    expect(
      (await metricsOf(ctx, factsFor([], stack, 'docker'), beta)).timeToReadyMs
    ).toBe(4000);
  });

  it('reports a docker-failure, manual cleanup, native-recovery run', async () => {
    const calls = [
      call('supabase stack start --runtime docker', {
        error: 'Cannot connect to the Docker daemon at tcp://127.0.0.1:1.',
      }),
      call('rm -rf ~/.supabase/stacks/abc123'),
      call('supabase stack start --runtime native', {
        result: 'Runtime: native',
      }),
    ];
    const metrics = await metricsOf(
      failingCtx,
      factsFor(
        calls,
        { ok: true, backend: 'managed', dbUrl: 'x', runtime: 'native' },
        'native'
      )
    );
    expect(metrics).toMatchObject({
      recoverySteps: 3,
      manualStackStateEdits: 1,
      startAttempts: ['docker→docker', 'native→native'],
      managedStackReached: true,
      runtimeMismatchErrors: 0,
      stackDestroyUsed: false,
      cliDetours: 0,
    });
  });

  it('counts runtime mismatches, destroys and regex detours', async () => {
    const calls = [
      call('supabase stack start --runtime native', {
        error:
          'Requested runtime native does not match existing stack runtime docker',
      }),
      call('supabase stack destroy --yes'),
      call('sudo systemctl start docker'),
    ];
    expect(await metricsOf(failingCtx, factsFor(calls))).toMatchObject({
      runtimeMismatchErrors: 1,
      stackDestroyUsed: true,
      cliDetours: 1,
    });
  });

  it('reports DOCKER_HOST handling and raw socket probes', async () => {
    const calls = [
      call('docker info'),
      call('unset DOCKER_HOST; supabase start'),
      call('export DOCKER_HOST=unix:///var/run/docker.sock'),
      call('curl --unix-socket /var/run/docker.sock http://localhost/_ping'),
    ];
    expect(await metricsOf(failingCtx, factsFor(calls))).toMatchObject({
      clearedDockerHost: 1,
      dockerHostOverrides: 1,
      rawDockerSocketProbes: 2,
    });
  });

  it('lists runner overrides and unverified runners', async () => {
    const calls = [
      call('npx -y supabase@2.0.0 stack start'),
      call('npx supabase@latest stack start'),
    ];
    expect(await metricsOf(failingCtx, factsFor(calls), beta)).toMatchObject({
      cliOverride: ['npx -y supabase@2.0.0'],
      cliRunnerUnverified: ['npx supabase@latest'],
    });
  });
});

describe('countManualStackStateEdits', () => {
  it.each([
    'rm -rf ~/.supabase/stacks/abc',
    'rm -rf "$HOME/.supabase/stacks"',
    'rm -rf ${HOME}/.supabase/stacks/abc',
    'rm -rf /root/.supabase/stacks/*',
    'mv ~/.supabase/stacks/abc /tmp/abc',
    'cp ~/.supabase/stacks/abc/stack.json /tmp',
    'sed -i s/docker/native/ ~/.supabase/stacks/abc/stack.json',
    "sed -i.bak 's/docker/native/' ~/.supabase/stacks/abc/stack.json",
    'echo native | tee ~/.supabase/stacks/abc/runtime',
    'echo {} > ~/.supabase/stacks/abc/stack.json',
    'echo {} >> $HOME/.supabase/stacks/abc/stack.json',
    'find ~/.supabase/stacks -name "*.lock" -delete',
    "bash -lc 'rm -rf ~/.supabase/stacks/abc'",
    'truncate -s 0 ~/.supabase/stacks/abc/stack.json',
  ])('counts one edit for %s', (command) => {
    expect(countManualStackStateEdits([command])).toBe(1);
  });

  it.each([
    'ls ~/.supabase/stacks',
    'cat ~/.supabase/stacks/abc/stack.json',
    'echo "rm -rf ~/.supabase/stacks"',
    'echo "rm -rf ~/.supabase/stacks" >> NOTES.md',
    "printf '%s' 'mv ~/.supabase/stacks /tmp' > notes.txt",
    'git commit -m "rm -rf ~/.supabase/stacks"',
    'sed s/a/b/ ~/.supabase/stacks/abc/stack.json',
    'find ~/.supabase/stacks -name "*.json"',
    'rm -rf ./build',
    'rm -rf ~/.supabase/cache',
    'supabase stack destroy --yes',
    'echo hi 2>&1',
  ])('does not count %s', (command) => {
    expect(countManualStackStateEdits([command])).toBe(0);
  });

  it('counts each executing segment across commands', () => {
    expect(
      countManualStackStateEdits([
        'rm -rf ~/.supabase/stacks/a && rm -rf ~/.supabase/stacks/b',
        'ls',
        "cat <<'EOF' > notes.md\nrm -rf ~/.supabase/stacks\nEOF",
        'rm -rf ~/.supabase/stacks/c',
      ])
    ).toBe(3);
  });
});

describe('countDockerHostOverrides', () => {
  it.each([
    ['export DOCKER_HOST=unix:///var/run/docker.sock', 1],
    ['export DOCKER_HOST=tcp://127.0.0.1:1', 1],
    ['DOCKER_HOST=unix:///var/run/docker.sock supabase start', 1],
    ['env DOCKER_HOST=tcp://localhost:2375 docker info', 1],
    ['env -u FOO DOCKER_HOST=tcp://localhost:2375 docker info', 1],
    ['export A=1 DOCKER_HOST=x', 1],
    ['DOCKER_HOST=a supabase start; DOCKER_HOST=b supabase start', 2],
    ["bash -lc 'export DOCKER_HOST=unix:///x && supabase start'", 1],
    ['DOCKER_HOST= supabase start', 0],
    ['unset DOCKER_HOST', 0],
    ['env -u DOCKER_HOST supabase start', 0],
    ['echo "DOCKER_HOST=unix:///x"', 0],
    ['echo DOCKER_HOST=unix:///x', 0],
    ['docker info', 0],
    ['supabase start --runtime docker', 0],
  ])('counts %s as %i', (command, expected) => {
    expect(countDockerHostOverrides([command])).toBe(expected);
  });
});

describe('countLeftoverDockerRegistrations', () => {
  const listing = (stdout: string, ok = true): ExecContext => ({
    exec: async (command) =>
      command.includes('stack list')
        ? commandResult(stdout, ok)
        : commandResult('', false),
  });

  it('is null unless native actually started', async () => {
    const ctx = listing('{"stacks":[{"id":"a","runtime":"docker"}]}');
    expect(await countLeftoverDockerRegistrations(ctx, 'docker')).toBeNull();
    expect(await countLeftoverDockerRegistrations(ctx, 'none')).toBeNull();
  });

  it('is null when the listing fails', async () => {
    expect(
      await countLeftoverDockerRegistrations(failingCtx, 'native')
    ).toBeNull();
    expect(
      await countLeftoverDockerRegistrations(listing('boom', false), 'native')
    ).toBeNull();
  });

  it('counts docker entries left behind while native runs', async () => {
    const ctx = listing(
      '{"stacks":[{"id":"a","runtime":"docker"},{"id":"b","runtime":"native"},{"id":"c","runtime":{"kind":"docker"}}]}'
    );
    expect(await countLeftoverDockerRegistrations(ctx, 'native')).toBe(2);
  });

  it('is zero for an empty listing or one with only native entries', async () => {
    expect(
      await countLeftoverDockerRegistrations(listing('{"stacks":[]}'), 'native')
    ).toBe(0);
    expect(
      await countLeftoverDockerRegistrations(
        listing('[{"id":"b","runtime":"native"}]'),
        'native'
      )
    ).toBe(0);
  });

  it('is null, never a false zero, when entries carry no runtime field', async () => {
    expect(
      await countLeftoverDockerRegistrations(
        listing('{"stacks":[{"id":"a"},{"id":"b"}]}'),
        'native'
      )
    ).toBeNull();
  });

  it('is reported by checkMetrics only when native runs', async () => {
    const ctx = listing('{"stacks":[{"id":"a","runtime":"docker"}]}');
    expect(
      (await metricsOf(ctx, factsFor([], NO_STACK, 'native')))
        .leftoverDockerRegistrations
    ).toBe(1);
    expect(
      (await metricsOf(failingCtx, factsFor([], NO_STACK, 'native')))
        .leftoverDockerRegistrations
    ).toBeNull();
  });
});
