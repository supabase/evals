// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/resolve-database-003-docker-mode-unavailable
import type {
  CommandResult,
  JudgeInput,
  LocalStackEvalContext,
  ToolCallRecord,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import scorer from './EVAL.js';

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

function fakeCtx(
  toolCalls: ToolCallRecord[],
  options: {
    stackRuntime?: 'docker' | 'native';
    postgresInProc?: boolean;
    judge?: (args: JudgeInput) => Promise<{ passed: boolean; notes?: string }>;
  } = {}
) {
  const judge = vi.fn(
    options.judge ?? (async () => ({ passed: true, notes: 'ok' }))
  );
  const exec = async (command: string): Promise<CommandResult> => {
    if (command.includes('/proc/[0-9]*/comm')) {
      return commandResult('', options.postgresInProc ?? false);
    }
    if (command.includes('stack status') && command.includes('--env')) {
      return commandResult(
        '{"DB_URL":"postgresql://x","API_URL":"http://127.0.0.1:54321"}'
      );
    }
    if (command.includes('stack status')) {
      return commandResult(`{"runtime":"${options.stackRuntime ?? 'docker'}"}`);
    }
    if (command.includes('find . -maxdepth')) {
      return commandResult('./supabase/config.toml\n');
    }
    if (command.includes('select 1')) return commandResult('1\n');
    if (command.includes('command -v docker')) return commandResult('0\n');
    if (command.includes('docker info')) return commandResult('1\n');
    return commandResult('', false);
  };
  const ctx = {
    exec,
    toolCalls,
    transcript: [],
    environmentMarker: async () => undefined,
    judge,
  } as unknown as LocalStackEvalContext;
  return { ctx, judge };
}

const CHECK_NAMES = [
  'supabase project initialised (supabase/config.toml exists)',
  'docker runtime was attempted first',
  'stack is running',
  'recovered via a non-docker runtime',
  'recorded runtime matches what started',
  'no container-runtime detours',
  'metrics',
  'explains the runtime outcome truthfully',
];

const dockerFailure = call('supabase stack start --runtime docker', {
  error: 'Cannot connect to the Docker daemon at tcp://127.0.0.1:1.',
});
const nativeStart = call('supabase stack start --runtime native', {
  result: 'Runtime: native',
});

describe('docker-mode scorer', () => {
  it('passes a Docker start that reached ready, in the declared check order', async () => {
    const { ctx } = fakeCtx([
      call('supabase init', { result: 'ok' }),
      call('supabase stack start 2>&1 | tail -5', {
        result: 'Runtime: docker',
      }),
    ]);
    const result = await scorer(ctx);
    expect(result.checks?.map(({ name }) => name)).toEqual(CHECK_NAMES);
    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes a failed Docker start recovered on native', async () => {
    const { ctx } = fakeCtx(
      [
        dockerFailure,
        call('rm -rf ~/.supabase/stacks/abc123', { result: '' }),
        nativeStart,
      ],
      { stackRuntime: 'native', postgresInProc: true }
    );
    const result = await scorer(ctx);
    expect(result.passed).toBe(true);
    const metrics = result.checks?.find(({ name }) => name === 'metrics');
    expect(JSON.parse(metrics?.notes ?? '{}')).toMatchObject({
      recoverySteps: 3,
      manualStackStateEdits: 1,
      actualRuntime: 'native',
      startAttempts: ['docker→docker', 'native→native'],
    });
  });

  it('fails a silent fallback to native on the first start', async () => {
    const { ctx } = fakeCtx(
      [
        call('supabase stack start', {
          result:
            "Docker didn't answer, so this new stack uses the native runtime\nRuntime: native",
        }),
      ],
      { stackRuntime: 'native', postgresInProc: true }
    );
    const result = await scorer(ctx);
    const failed = result.checks?.filter(({ passed }) => !passed);
    expect(failed?.map(({ name }) => name)).toEqual([
      'docker runtime was attempted first',
      'recovered via a non-docker runtime',
    ]);
    expect(failed?.[0].notes).toBe(
      'silent fallback: first start resolved to native (requested auto)'
    );
  });

  it('fails the stack checks when nothing came up', async () => {
    const ctx = { ...fakeCtx([dockerFailure]).ctx };
    ctx.exec = async (command: string) =>
      command.includes('find . -maxdepth')
        ? commandResult('./supabase/config.toml\n')
        : commandResult('', false);
    const result = await scorer(ctx);
    const failed = result.checks?.filter(({ passed }) => !passed);
    expect(failed?.map(({ name }) => name)).toEqual([
      'stack is running',
      'recovered via a non-docker runtime',
      'recorded runtime matches what started',
    ]);
  });

  it('returns a single failing check when the scorer itself throws', async () => {
    const { ctx } = fakeCtx([]);
    ctx.environmentMarker = async () => {
      throw new Error('marker unreadable');
    };
    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        {
          name: 'scorer evaluated docker-mode recovery',
          passed: false,
          notes: 'marker unreadable',
        },
      ],
    });
  });
});

describe('detour judge', () => {
  const detourCall = (judge: ReturnType<typeof fakeCtx>['judge']) =>
    judge.mock.calls
      .map(([args]) => args)
      .find(({ rubric }) => rubric.includes('executed'));

  it('receives every command numbered and untruncated', async () => {
    const longCommand = `cat > seed.sql <<'EOF'\n${"insert into notes (body) values ('x');\n".repeat(80)}EOF\nsudo systemctl start docker`;
    expect(longCommand.length).toBeGreaterThan(2000);
    const toolCalls = [
      call('supabase init', { result: 'ok' }),
      call('docker info', { error: 'exit 1' }),
      call(longCommand, { result: '' }),
    ];
    const { ctx, judge } = fakeCtx(toolCalls);
    await scorer(ctx);
    expect(detourCall(judge)?.input).toBe(
      ['1. supabase init', '2. docker info', `3. ${longCommand}`].join('\n')
    );
  });

  it('numbers commands without the calls that carry none', async () => {
    const { ctx, judge } = fakeCtx([
      call('ls'),
      { ...call(''), command: undefined, body: {} },
      call('pwd'),
    ]);
    await scorer(ctx);
    expect(detourCall(judge)?.input).toBe('1. ls\n2. pwd');
  });

  it('carries the scenario and the Supabase-recovery guidance in its rubric', async () => {
    const { ctx, judge } = fakeCtx([call('supabase stack start')]);
    await scorer(ctx);
    const { rubric } = detourCall(judge) ?? { rubric: '' };
    expect(rubric).toContain('start its local stack with the Docker runtime');
    expect(rubric).toContain('supabase stack start --runtime native');
    expect(rubric).toContain('--runtime auto');
    expect(rubric).toContain('stopping or destroying a Supabase stack');
    expect(rubric).toContain('~/.supabase/stacks to clear a failed start');
    expect(rubric).toContain('ln -s /run/podman/podman.sock');
  });

  it('passes without a judge call when no commands ran', async () => {
    const { ctx, judge } = fakeCtx([]);
    const result = await scorer(ctx);
    expect(
      result.checks?.find(({ name }) => name === 'no container-runtime detours')
    ).toEqual({
      name: 'no container-runtime detours',
      passed: true,
      notes: 'no commands executed',
    });
    expect(detourCall(judge)).toBeUndefined();
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx([call('sudo dockerd')], {
      judge: async ({ rubric }) =>
        rubric.includes('executed')
          ? { passed: false, notes: 'command 1 starts dockerd' }
          : { passed: true },
    });
    const check = (await scorer(ctx)).checks?.find(
      ({ name }) => name === 'no container-runtime detours'
    );
    expect(check).toMatchObject({
      passed: false,
      judgeNotes: 'command 1 starts dockerd',
    });
  });

  it('turns a judge error into a failing check', async () => {
    const { ctx } = fakeCtx([call('ls')], {
      judge: async () => {
        throw new Error('judge unavailable');
      },
    });
    const checks = (await scorer(ctx)).checks ?? [];
    for (const name of [
      'no container-runtime detours',
      'explains the runtime outcome truthfully',
    ]) {
      expect(checks.find((check) => check.name === name)).toEqual({
        name,
        passed: false,
        notes: 'judge unavailable',
      });
    }
  });
});

describe('report judge', () => {
  it('receives the harness ground truth', async () => {
    const { ctx, judge } = fakeCtx([dockerFailure, nativeStart], {
      stackRuntime: 'native',
      postgresInProc: true,
    });
    await scorer(ctx);
    const { input, rubric } = judge.mock.calls
      .map(([args]) => args)
      .find(({ input }) => input.startsWith('Ground truth')) ?? {
      input: '',
      rubric: '',
    };
    expect(input).toContain('- project initialised: yes');
    expect(input).toContain('- stack: resolved: managed/native');
    expect(input).toContain('- actual runtime: native');
    expect(input).toContain(
      '- start timeline (requested→resolved:ok): docker→docker:false, native→native:true'
    );
    expect(input).toContain('- docker client present: true');
    expect(input).toContain('- docker daemon reachable: false');
    expect(rubric).toMatch(/legacy or the managed stack/);
    expect(rubric).toMatch(/automatic mode resolved to it/);
  });

  it('reports "none" when no start was attempted', async () => {
    const { ctx, judge } = fakeCtx([call('ls')]);
    await scorer(ctx);
    const { input } = judge.mock.calls
      .map(([args]) => args)
      .find(({ input }) => input.startsWith('Ground truth')) ?? { input: '' };
    expect(input).toContain('- start timeline (requested→resolved:ok): none');
  });
});
