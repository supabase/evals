import { describe, expect, it } from 'vitest';
import {
  positiveInteger,
  readExperimentFilters,
  readFlag,
} from './cli-args.js';

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

describe('readExperimentFilters', () => {
  it('reads <suite>/<name> from repeated and comma-separated flags', () => {
    expect(
      readExperimentFilters([
        '--experiment',
        'benchmark/grok-4.7,regression/codex-gpt-6-luna',
        '--experiment',
        'experiments/docs/codex-gpt-6-luna-no-skills',
      ])
    ).toEqual([
      { suite: 'benchmark', name: 'grok-4.7' },
      { suite: 'regression', name: 'codex-gpt-6-luna' },
      { suite: 'docs', name: 'codex-gpt-6-luna-no-skills' },
    ]);
  });

  it('requires the suite folder', () => {
    expect(() => readExperimentFilters(['--experiment', 'grok-4.7'])).toThrow(
      'Expected <suite>/<name>'
    );
  });
});
