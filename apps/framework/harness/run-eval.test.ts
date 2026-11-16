import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  assertLocalMatchesInterface,
  combineExperimentalAttempts,
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
  };
  const applied = ['SUPABASE_EXPERIMENTAL=true (same as --experimental)'];

  it('reports the retry as the result when it passes', () => {
    const retry = {
      passed: true,
      checks: [{ name: 'default', passed: true }],
      cliVersion: '3.1.0',
      marker: 'retry',
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
        },
      },
    });
  });
});
