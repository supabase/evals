import { describe, expect, it } from 'vitest';
import { readFlag } from './cli-args.js';

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
  });
});
