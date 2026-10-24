import { describe, expect, it } from 'vitest';
import {
  positiveInteger,
  readFlag,
  readRepeatedFlag,
  readSdkFilters,
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

describe('readRepeatedFlag', () => {
  it('collects repeated and comma-separated values in either form', () => {
    expect(
      readRepeatedFlag(['--sdk', 'js', '--sdk=py,swift', '--other'], 'sdk')
    ).toEqual(['js', 'py', 'swift']);
    expect(readRepeatedFlag(['--other', 'x'], 'sdk')).toEqual([]);
    expect(() => readRepeatedFlag(['--sdk', '--other'], 'sdk')).toThrow(
      '--sdk requires a value'
    );
  });
});

describe('readSdkFilters', () => {
  it('validates --sdk values against the sdk enum', () => {
    expect(readSdkFilters(['--sdk', 'py'])).toEqual(['py']);
    expect(readSdkFilters(['--sdk=JS,py'])).toEqual(['js', 'py']);
    expect(readSdkFilters([])).toEqual([]);
    expect(() => readSdkFilters(['--sdk', 'go'])).toThrow(
      'invalid sdk "go". Expected one of: js, py, swift, flutter, kotlin, csharp'
    );
  });
});
