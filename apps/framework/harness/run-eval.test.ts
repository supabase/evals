import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { assertLocalMatchesInterface } from './run-eval.js';

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
