import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertLocalMatchesInterface,
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

  function fakeRuntime(id: string, startedIds: string[]) {
    return {
      id,
      startSession: vi.fn(async () => {
        startedIds.push(id);
        return {
          sandbox: { readFile: async () => '' },
          tools: {},
          mcpServers: [],
          promptAddendum: '',
          scoringContext: { environmentMarker: async () => undefined },
          exportWorkspace: async (dir: string) => {
            mkdirSync(dir, { recursive: true });
          },
          close: async () => {},
        };
      }),
    };
  }

  function setup({
    fallback,
    scores,
    fallbackThrows = false,
  }: {
    fallback: boolean;
    scores: boolean[];
    fallbackThrows?: boolean;
  }) {
    const startedIds: string[] = [];
    const fallbackRuntime = fakeRuntime('fallback-runtime', startedIds);
    if (fallbackThrows) {
      fallbackRuntime.startSession.mockRejectedValue(new Error('boom'));
    }
    const exp = {
      agent: {
        id: 'fake-agent',
        run: vi.fn(async (args: { sessionArchivePath: string }) => {
          archivePaths.push(args.sessionArchivePath);
          return {
            toolCalls: [],
            transcript: [],
            agentReport: '',
            stoppedReason: 'done',
            durationMs: 1,
            startedAt: 0,
          };
        }),
      },
      localStack: fakeRuntime('primary-runtime', startedIds),
      ...(fallback ? { fallbackConfig: { localStack: fallbackRuntime } } : {}),
    };
    const archivePaths: string[] = [];
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
    return { ctx, startedIds, archivePaths };
  }

  it('reruns a failed first attempt on the fallback runtime and keeps the first result', async () => {
    const { ctx, startedIds, archivePaths } = setup({
      fallback: true,
      scores: [false, true],
    });
    const result = await runLocalStackWithFallback(ctx);
    expect(startedIds).toEqual(['primary-runtime', 'fallback-runtime']);
    expect(result.passed).toBe(false);
    expect(result.fallback).toMatchObject({
      outcome: 'passed',
      runtime: 'fallback-runtime',
      passed: true,
    });
    expect(archivePaths[0]).toMatch(/session-archive\.tar\.gz$/);
    expect(archivePaths[1]).toMatch(/session-archive-fallback\.tar\.gz$/);
  });

  it('records a failing fallback', async () => {
    const { ctx } = setup({ fallback: true, scores: [false, false] });
    const result = await runLocalStackWithFallback(ctx);
    expect(result.passed).toBe(false);
    expect(result.fallback?.outcome).toBe('failed');
  });

  it('records an errored fallback and keeps the first result', async () => {
    const { ctx } = setup({
      fallback: true,
      scores: [false],
      fallbackThrows: true,
    });
    const result = await runLocalStackWithFallback(ctx);
    expect(result.passed).toBe(false);
    expect(result.fallback).toMatchObject({
      outcome: 'errored',
      passed: false,
      error: 'boom',
    });
  });

  it('does not run the fallback when the first attempt passes', async () => {
    const { ctx, startedIds } = setup({ fallback: true, scores: [true] });
    const result = await runLocalStackWithFallback(ctx);
    expect(startedIds).toEqual(['primary-runtime']);
    expect(result.fallback).toBeUndefined();
  });

  it('does not run a fallback when none is configured', async () => {
    const { ctx, startedIds } = setup({ fallback: false, scores: [false] });
    const result = await runLocalStackWithFallback(ctx);
    expect(startedIds).toEqual(['primary-runtime']);
    expect(result.fallback).toBeUndefined();
  });
});
