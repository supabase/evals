import { describe, expect, it } from 'vitest';
import { positiveInteger, readFlag, validateCliArgs } from './cli-args.js';

describe('readFlag', () => {
  it('reads flags in both --name value and --name=value form', () => {
    expect(readFlag(['--runs', '3'], 'runs')).toBe('3');
    expect(readFlag(['--runs=3'], 'runs')).toBe('3');
    expect(readFlag(['--other', 'x'], 'runs')).toBeUndefined();
    expect(() => readFlag(['--runs'], 'runs')).toThrow(
      '--runs requires a value'
    );
    expect(() => readFlag(['--runs', '--other'], 'runs')).toThrow(
      '--runs requires a value'
    );
    expect(() => readFlag(['--runs='], 'runs')).toThrow(
      '--runs requires a value'
    );
  });
});

describe('validateCliArgs', () => {
  const definition = {
    booleanFlags: ['strict', 'smoke'],
    valueFlags: ['mcp', 'eval'],
    positionals: ['list'],
    usage: 'Usage: pnpm eval -- [list] [options]',
  };

  it('accepts declared flags, values, separators, and positionals', () => {
    expect(() =>
      validateCliArgs(
        ['--', 'list', '--strict', '--mcp', './server', '--eval=id'],
        definition
      )
    ).not.toThrow();
  });

  it('rejects unknown flags with a close-match hint and usage', () => {
    expect(() => validateCliArgs(['--strcit'], definition)).toThrow(
      'unknown argument: --strcit\nDid you mean --strict?\n\nUsage:'
    );
    expect(() => validateCliArgs(['--mpc', './server'], definition)).toThrow(
      'unknown argument: --mpc\nDid you mean --mcp?\n\nUsage:'
    );
  });

  it('rejects unexpected positionals', () => {
    expect(() => validateCliArgs(['run'], definition)).toThrow(
      'unexpected argument: run\n\nUsage:'
    );
  });
});

describe('positiveInteger', () => {
  it('rejects non-positive-integer CLI options', () => {
    expect(positiveInteger('3', 'runs')).toBe(3);
    expect(() => positiveInteger('0', 'runs')).toThrow(
      '--runs must be a positive integer'
    );
    expect(() => positiveInteger('-1', 'runs')).toThrow(
      '--runs must be a positive integer'
    );
    expect(() => positiveInteger('1.5', 'runs')).toThrow(
      '--runs must be a positive integer'
    );
    expect(() => positiveInteger('abc', 'runs')).toThrow(
      '--runs must be a positive integer'
    );
  });
});
