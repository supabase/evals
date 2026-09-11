import { describe, expect, it } from 'vitest';
import { assertLocalMatchesInterface } from './run-eval.js';

describe('assertLocalMatchesInterface', () => {
  it('throws when a local/ workspace is declared as interface: mcp', () => {
    expect(() => assertLocalMatchesInterface('evals/regression/some-eval/PROMPT.md', 'mcp', true)).toThrow(
      'expected cli'
    );
  });

  it('allows local/ with interface: cli, and no local/ with any interface', () => {
    expect(() =>
      assertLocalMatchesInterface('evals/regression/some-eval/PROMPT.md', 'cli', true)
    ).not.toThrow();
    expect(() =>
      assertLocalMatchesInterface('evals/regression/some-eval/PROMPT.md', 'mcp', false)
    ).not.toThrow();
  });
});
