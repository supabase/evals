import { describe, expect, it } from 'vitest';
import { enableExperimentalStack } from '../src/experimental-stack.js';
import { localStackRuntime } from '../src/local-stack-runtime.js';

describe('enableExperimentalStack (toml)', () => {
  it('inserts stack right after [experimental] and leaves subtables alone', () => {
    const input = [
      '[db]',
      'port = 54322',
      '',
      '[experimental]',
      '# s3_host = "env(S3_HOST)"',
      '# s3_region = "env(S3_REGION)"',
      '',
      '[experimental.pgdelta]',
      'enabled = false',
      '',
    ].join('\n');
    expect(enableExperimentalStack(input, 'toml')).toBe(
      [
        '[db]',
        'port = 54322',
        '',
        '[experimental]',
        'stack = true',
        '# s3_host = "env(S3_HOST)"',
        '# s3_region = "env(S3_REGION)"',
        '',
        '[experimental.pgdelta]',
        'enabled = false',
        '',
      ].join('\n')
    );
  });

  it('replaces an existing stack = false inside [experimental]', () => {
    const input = '[experimental]\nstack = false\nother = 1\n';
    expect(enableExperimentalStack(input, 'toml')).toBe(
      '[experimental]\nstack = true\nother = 1\n'
    );
  });

  it('does not rewrite a stack key that belongs to another table', () => {
    const input = '[experimental]\n[other]\nstack = false\n';
    expect(enableExperimentalStack(input, 'toml')).toBe(
      '[experimental]\nstack = true\n[other]\nstack = false\n'
    );
  });

  it('appends an [experimental] table when none exists', () => {
    expect(enableExperimentalStack('[db]\nport = 1\n', 'toml')).toBe(
      '[db]\nport = 1\n\n[experimental]\nstack = true\n'
    );
    expect(enableExperimentalStack('[db]\nport = 1', 'toml')).toBe(
      '[db]\nport = 1\n\n[experimental]\nstack = true\n'
    );
  });
});

describe('enableExperimentalStack (jsonc)', () => {
  it('sets stack inside an existing experimental object and keeps comments', () => {
    const input = [
      '{',
      '  // project settings',
      '  "db": { "port": 54322 },',
      '  "experimental": {',
      '    // gated features',
      '    "stack": false',
      '  }',
      '}',
      '',
    ].join('\n');
    const output = enableExperimentalStack(input, 'jsonc');
    expect(output).toContain('// project settings');
    expect(output).toContain('// gated features');
    expect(output).toContain('"stack": true');
    expect(output).not.toContain('"stack": false');
  });

  it('adds the experimental object when absent', () => {
    const input = '{\n  // keep me\n  "db": { "port": 54322 }\n}\n';
    const output = enableExperimentalStack(input, 'jsonc');
    expect(output).toContain('// keep me');
    expect(JSON.parse(output.replace(/\/\/.*$/gm, ''))).toEqual({
      db: { port: 54322 },
      experimental: { stack: true },
    });
  });
});

describe('localStackRuntime experimentalFallback', () => {
  it('defaults to false and reflects the option', () => {
    expect(localStackRuntime().experimentalFallback).toBe(false);
    expect(
      localStackRuntime({ experimentalFallback: true }).experimentalFallback
    ).toBe(true);
  });
});
