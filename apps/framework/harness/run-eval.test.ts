import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertLocalMatchesInterface,
  combineExperimentalAttempts,
  runLocalStackWithFallback,
  type LocalStackAttemptContext,
} from './run-eval.js';

describe('assertLocalMatchesInterface', () => {
  it('throws when a local/ workspace is declared as interface: mcp', () => {
    expect(() =>
      assertLocalMatchesInterface(
        'evals/regression/some-eval/PROMPT.md',
        'mcp',
        true
      )
    ).toThrow('expected cli');
  });

  it('allows local/ with interface: cli, and no local/ with any interface', () => {
    expect(() =>
      assertLocalMatchesInterface(
        'evals/regression/some-eval/PROMPT.md',
        'cli',
        true
      )
    ).not.toThrow();
    expect(() =>
      assertLocalMatchesInterface(
        'evals/regression/some-eval/PROMPT.md',
        'mcp',
        false
      )
    ).not.toThrow();
  });
});

describe('smoke selection', () => {
  it('plans eligible experiments in every suite and honors filters', () => {
    const plan = (...args: string[]) =>
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx/esm',
          'harness/run-eval.ts',
          '--smoke',
          '--dry',
          ...args,
        ],
        { cwd: import.meta.dirname + '/..', encoding: 'utf8' }
      );
    const all = plan();
    for (const suite of ['benchmark', 'regression', 'docs', 'cli']) {
      expect(all).toContain(`PLAN ${suite}/`);
    }
    expect(all).toContain('PLAN cli/codex-gpt-6-luna-cli-absent x');
    expect(all).toContain('PLAN cli/codex-gpt-6-luna-cli-nodaemon x');

    const filtered = plan(
      '--suite',
      'regression',
      '--eval',
      'resolve-dataapi-002-secure-default-grants'
    );
    expect(filtered).toContain('PLAN regression/');
    expect(filtered).toContain(' x resolve-dataapi-002-secure-default-grants ');
    expect(filtered).not.toContain('PLAN benchmark/');
  }, 15000);
});

describe('experiment selection', () => {
  it('infers the suite, pairs each suite, and rejects missing names', () => {
    const plan = (...args: string[]) =>
      execFileSync(
        process.execPath,
        ['--import', 'tsx/esm', 'harness/run-eval.ts', '--dry', ...args],
        {
          cwd: import.meta.dirname + '/..',
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
    const single = plan(
      '--eval',
      'resolve-dataapi-001-empty-results',
      '--experiment',
      'codex-gpt-6-luna'
    );
    expect(single).toContain(
      'PLAN benchmark/codex-gpt-6-luna x resolve-dataapi-001-empty-results'
    );
    expect(single).not.toContain('PLAN regression/');

    const both = plan(
      '--suite',
      'benchmark,regression',
      '--experiment',
      'codex-gpt-6-luna'
    );
    expect(both).toContain('PLAN benchmark/codex-gpt-6-luna x');
    expect(both).toContain('PLAN regression/codex-gpt-6-luna x');
    expect(() =>
      plan('--suite', 'benchmark,regression', '--experiment', 'grok-4.7')
    ).toThrow('regression/grok-4.7');
  }, 15000);
});

describe('combineExperimentalAttempts', () => {
  const first = {
    passed: false,
    checks: [{ name: 'default', passed: false }],
    cliVersion: '3.1.0',
    marker: 'first',
    usage: [
      {
        model: 'm',
        inputTokens: 10,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
      },
    ],
    judgeCalls: [
      {
        provider: 'p',
        system: 's',
        prompt: 'q',
        output: { passed: false, notes: 'n' },
        model: 'judge',
        usage: { inputTokens: 3 },
        startedAt: 0,
        durationMs: 1,
      },
    ],
  };
  const applied = ['SUPABASE_EXPERIMENTAL=true (same as --experimental)'];

  it('reports the retry as the result when it passes', () => {
    const retry = {
      passed: true,
      checks: [{ name: 'default', passed: true }],
      cliVersion: '3.1.0',
      marker: 'retry',
      usage: first.usage,
      judgeCalls: first.judgeCalls,
    };
    expect(combineExperimentalAttempts(first, retry, applied)).toEqual({
      ...retry,
      experimentalFallback: {
        outcome: 'passed-with-experimental',
        applied,
        otherAttempt: {
          passed: false,
          checks: first.checks,
          cliVersion: '3.1.0',
          usage: first.usage,
          judgeCalls: first.judgeCalls,
        },
      },
    });
  });

  it('keeps the default failure when the retry also fails', () => {
    const retry = {
      passed: false,
      checks: [{ name: 'experimental', passed: false }],
      cliVersion: '3.1.0',
      marker: 'retry',
      usage: first.usage,
      judgeCalls: first.judgeCalls,
    };
    expect(combineExperimentalAttempts(first, retry, applied)).toEqual({
      ...first,
      experimentalFallback: {
        outcome: 'failed-with-experimental',
        applied,
        otherAttempt: {
          passed: false,
          checks: retry.checks,
          cliVersion: '3.1.0',
          usage: retry.usage,
          judgeCalls: retry.judgeCalls,
        },
      },
    });
  });
});

describe('runLocalStackWithFallback', () => {
  const expName = 'zz-fallback-test';
  const resultsDir = join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'results',
    expName
  );
  afterEach(() => rmSync(resultsDir, { recursive: true, force: true }));

  function setup(fallback: boolean) {
    const startArgs: Array<{ experimental?: boolean }> = [];
    const scores = [false, true];
    const exp = {
      agent: {
        id: 'fake-agent',
        run: vi.fn(async () => ({
          toolCalls: [],
          transcript: [],
          agentReport: '',
          stoppedReason: 'done',
          durationMs: 1,
          startedAt: 0,
        })),
      },
      localStack: {
        id: 'fake',
        experimentalFallback: fallback,
        startSession: vi.fn(async (args: { experimental?: boolean }) => {
          startArgs.push(args);
          return {
            sandbox: { readFile: async () => '' },
            tools: {},
            mcpServers: [],
            promptAddendum: '',
            scoringContext: { environmentMarker: async () => undefined },
            experimentalApplied: args.experimental
              ? ['SUPABASE_EXPERIMENTAL=true']
              : [],
            exportWorkspace: async (dir: string) => {
              mkdirSync(dir, { recursive: true });
            },
            close: async () => {},
          };
        }),
      },
    };
    const ctx = {
      expName,
      exp,
      ev: {
        id: 'fake-eval',
        metadata: { services: [], projectRunning: true, product: [] },
        localDir: undefined,
        dir: '/nonexistent',
      },
      runIndex: 1,
      prompt: 'do it',
      scorer: async () => ({ passed: scores.shift() ?? true, checks: [] }),
      skillSources: [],
      availableSkills: [],
    } as unknown as LocalStackAttemptContext;
    return { ctx, startArgs };
  }

  it('retries with experimental on and promotes a passing retry', async () => {
    const { ctx, startArgs } = setup(true);
    const result = await runLocalStackWithFallback(ctx);
    expect(startArgs).toHaveLength(2);
    expect(startArgs[0]?.experimental).toBeFalsy();
    expect(startArgs[1]?.experimental).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.experimentalFallback).toMatchObject({
      outcome: 'passed-with-experimental',
      applied: ['SUPABASE_EXPERIMENTAL=true'],
    });
  });

  it('does not retry when the runtime has not opted in', async () => {
    const { ctx, startArgs } = setup(false);
    const result = await runLocalStackWithFallback(ctx);
    expect(startArgs).toHaveLength(1);
    expect(result.passed).toBe(false);
    expect(result.experimentalFallback).toBeUndefined();
  });
});
