import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
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

  it('only accepts positionals in the command position', () => {
    expect(() => validateCliArgs(['--strict', 'list'], definition)).toThrow(
      'unexpected argument: list\n\nUsage:'
    );
  });
});

describe('run-eval argument validation', () => {
  const frameworkRoot = join(import.meta.dirname, '..');

  function run(...args: string[]) {
    return spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', 'harness/run-eval.ts', ...args],
      {
        cwd: frameworkRoot,
        encoding: 'utf8',
      }
    );
  }

  it.each([
    ['--strcit', '--strict'],
    ['--mpc', '--mcp'],
  ])('rejects unknown argument %s before running', (token, hint) => {
    const result = run(token, './server');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`unknown argument: ${token}`);
    expect(result.stderr).toContain(`Did you mean ${hint}?`);
    expect(result.stderr).toContain('Usage: pnpm eval');
  });

  it('accepts a valid list invocation', () => {
    const result = run('list', '--experiment-suite', 'benchmark');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('codex-gpt-5.6');
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
