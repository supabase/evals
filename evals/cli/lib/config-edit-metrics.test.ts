import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from './cli-invocations.js';
import { parseEnvFile } from './config-edit-checks.js';
import {
  commentSurvival,
  countConfigEditInvocations,
} from './config-edit-metrics.js';

const count = (
  entries: { command: string; failed?: boolean; output?: string }[]
) => countConfigEditInvocations(entries, findSupabaseInvocations(entries));

describe('countConfigEditInvocations', () => {
  it('separates validate runs from other config-loading commands', () => {
    expect(
      count([
        { command: 'supabase config validate', failed: true },
        { command: 'supabase config validate' },
        { command: 'supabase start', failed: true },
        { command: 'supabase db lint' },
        { command: 'supabase login' },
        { command: 'supabase --version' },
        { command: 'ls supabase' },
      ])
    ).toEqual({
      validateRuns: 2,
      validateFailures: 1,
      otherConfigRuns: 2,
      otherConfigFailures: 1,
    });
  });
});

describe('validate failures hidden from the exit code', () => {
  it.each([
    'supabase config validate 2>&1 | tail -20',
    'supabase config validate || true',
  ])('classifies %s by its output', (command) => {
    const outputs = [
      '{"valid":false,"errors":[{"path":"auth"}]}',
      '✗ 2 error(s) in supabase/config.toml',
      'supabase/config.jsonc has 1 problem',
      'Error: auth.external.github.secret: env(X) is not set',
      'unknown command "validate" for "supabase config"',
    ];
    for (const output of outputs) {
      expect(count([{ command, output }]).validateFailures).toBe(1);
    }
  });

  it('does not fail a validate run whose output reports a valid config', () => {
    expect(
      count([
        {
          command: 'supabase config validate',
          output: '{"valid":true,"errors":[]}',
        },
        { command: 'supabase config validate', output: 'Config is valid.' },
      ]).validateFailures
    ).toBe(0);
  });
});

describe('commentSurvival', () => {
  it('counts surviving TOML comment lines', () => {
    const seed = '# one\n# two\nkey = 1\n# three\n# four\n';
    expect(commentSurvival('toml', seed, '# one\nkey = 2\n  # four\n')).toBe(
      0.5
    );
  });

  it('counts surviving JSONC line and block comment lines', () => {
    const seed = '{\n  // one\n  /* two\n   * three */\n  "a": 1\n}';
    expect(commentSurvival('jsonc', seed, '{\n  // one\n  "a": 2\n}')).toBe(
      0.33
    );
  });

  it('is null without a final file or seed comments', () => {
    expect(commentSurvival('toml', '# a\n', undefined)).toBeNull();
    expect(commentSurvival('toml', 'a = 1\n', 'a = 1\n')).toBeNull();
  });

  it('does not count a repeated comment more often than the seed had it', () => {
    expect(commentSurvival('toml', '# a\n', '# a\n# a\n')).toBe(1);
  });
});

describe('parseEnvFile', () => {
  it('reads assignments, quotes, export and empty values', () => {
    expect(
      parseEnvFile('# c\nA=1\nexport B="two"\nC=\n D = \'x\' \nnot a line\n')
    ).toEqual({ A: '1', B: 'two', C: '', D: 'x' });
  });
});
