import type { LocalStackRuntimeOptions } from '@supabase-evals/sandbox';
import { describe, expect, it, vi } from 'vitest';
import { EVAL_ENV } from './eval-env.js';

const recorded = vi.hoisted(() => [] as LocalStackRuntimeOptions[]);

vi.mock('@supabase-evals/sandbox', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@supabase-evals/sandbox')>();
  return {
    ...actual,
    localStackRuntime: (options: LocalStackRuntimeOptions = {}) => {
      recorded.push(options);
      return actual.localStackRuntime(options);
    },
  };
});

const { cliRuntime } = await import('./cli-runtime.js');

const SESSION_ENV = Symbol('env');
const fakeRuntime = (env: Record<string, string> | undefined) => ({
  id: 'fake',
  startSession: vi.fn(async () => ({ [SESSION_ENV]: env })),
});

describe('cliRuntime', () => {
  it('builds a managed-stack runtime and a harness-stack runtime when experimental', () => {
    recorded.length = 0;
    cliRuntime({ cliVersion: 'stable', env: EVAL_ENV, experimental: true });
    expect(recorded.map((options) => options.env)).toEqual([
      {
        SUPABASE_EVAL: '1',
        SUPABASE_EXPERIMENTAL: 'true',
        SUPABASE_EXPERIMENTAL_STACK: '1',
      },
      { SUPABASE_EVAL: '1', SUPABASE_EXPERIMENTAL: 'true' },
    ]);
  });

  it('sets the experimental env without a base env', () => {
    recorded.length = 0;
    cliRuntime({ experimental: true });
    expect(recorded.map((options) => options.env)).toEqual([
      { SUPABASE_EXPERIMENTAL: 'true', SUPABASE_EXPERIMENTAL_STACK: '1' },
      { SUPABASE_EXPERIMENTAL: 'true' },
    ]);
  });

  it('marks the experimental runtime id', () => {
    expect(cliRuntime({ cliVersion: 'stable' }).id).toBe('local-stack-stable');
    expect(cliRuntime({ cliVersion: 'stable', experimental: true }).id).toBe(
      'local-stack-stable-experimental'
    );
  });

  it('only enables the managed stack when the agent starts the stack', async () => {
    const spy = vi
      .spyOn(await import('@supabase-evals/sandbox'), 'localStackRuntime')
      .mockImplementation((options = {}) => fakeRuntime(options.env) as never);
    const runtime = cliRuntime({ env: EVAL_ENV, experimental: true });
    const notRunning = (await runtime.startSession({
      agent: 'codex',
      projectRunning: false,
    })) as unknown as Record<symbol, unknown>;
    const running = (await runtime.startSession({
      agent: 'codex',
      projectRunning: true,
    })) as unknown as Record<symbol, unknown>;
    spy.mockRestore();
    expect(notRunning[SESSION_ENV]).toHaveProperty(
      'SUPABASE_EXPERIMENTAL_STACK',
      '1'
    );
    expect(running[SESSION_ENV]).not.toHaveProperty(
      'SUPABASE_EXPERIMENTAL_STACK'
    );
    expect(running[SESSION_ENV]).toHaveProperty(
      'SUPABASE_EXPERIMENTAL',
      'true'
    );
  });

  it('leaves the env untouched when not experimental', () => {
    cliRuntime({ cliVersion: 'stable', env: EVAL_ENV });
    expect(recorded.at(-1)?.env).toEqual(EVAL_ENV);
    cliRuntime({ experimental: false });
    expect(recorded.at(-1)?.env).toBeUndefined();
  });

  it('does not forward the experimental flag to the runtime options', () => {
    cliRuntime({ experimental: true });
    expect(recorded.at(-1)).not.toHaveProperty('experimental');
  });

  it('passes the env validation of the local stack runtime', () => {
    expect(() =>
      cliRuntime({ env: EVAL_ENV, experimental: true })
    ).not.toThrow();
  });
});
