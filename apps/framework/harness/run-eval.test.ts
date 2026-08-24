import { describe, expect, it } from 'vitest';
import { assertLocalMatchesInterface } from './run-eval.js';

describe('assertLocalMatchesInterface', () => {
  it('throws when a local/ workspace is declared as interface: mcp', () => {
    expect(() =>
      assertLocalMatchesInterface('some-eval', 'mcp', true)
    ).toThrow('expected cli');
  });

  it('allows local/ with interface: cli, and no local/ with any interface', () => {
    expect(() =>
      assertLocalMatchesInterface('some-eval', 'cli', true)
    ).not.toThrow();
    expect(() =>
      assertLocalMatchesInterface('some-eval', 'mcp', false)
    ).not.toThrow();
  });
});
