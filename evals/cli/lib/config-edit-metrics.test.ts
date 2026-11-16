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
        {
          command: 'supabase config validate',
          output: '{"valid":false,"errors":[]}',
        },
        { command: 'supabase config validate', output: '{"valid":true}' },
        { command: 'supabase start', failed: true },
        { command: 'supabase db lint' },
        { command: 'supabase login' },
        { command: 'supabase --version' },
        { command: 'ls supabase' },
      ])
    ).toEqual({
      validateRuns: 2,
      validateInvalid: 1,
      validateUnavailable: 0,
      otherConfigRuns: 2,
      otherConfigFailures: 1,
    });
  });
});

describe('chained validates in one tool call', () => {
  it('counts every run but classifies the call once', () => {
    expect(
      count([
        {
          command:
            'supabase config validate; python3 fix.py; supabase config validate',
          output: '{"valid":false,"errors":[]}\n{"valid":true}',
        },
      ])
    ).toMatchObject({ validateRuns: 2, validateInvalid: 1 });
  });

  it('counts separate invalid tool calls separately', () => {
    expect(
      count([
        { command: 'supabase config validate', output: '{"valid":false}' },
        { command: 'supabase config validate', output: '{"valid":false}' },
      ])
    ).toMatchObject({ validateRuns: 2, validateInvalid: 2 });
  });
});

describe('validate runs classified by their report', () => {
  it.each([
    'supabase config validate 2>&1 | tail -20',
    'supabase config validate || true',
  ])('counts an invalid report from %s', (command) => {
    const outputs = [
      '{"valid":false,"errors":[{"path":"auth"}]}',
      '✗ 2 error(s) in supabase/config.toml',
      'supabase/config.jsonc has 1 problem',
    ];
    for (const output of outputs) {
      expect(count([{ command, output }]).validateInvalid).toBe(1);
    }
  });

  it('counts a CLI without validate as unavailable, not invalid', () => {
    const outputs = [
      '{"_tag":"Error","error":{"code":"UnknownSubcommand"}}',
      '{"_tag":"Help","doc":{"description":"Manage Supabase project configurations."}}',
      'unknown command "validate" for "supabase config"',
    ];
    for (const output of outputs) {
      expect(
        count([{ command: 'supabase config validate', output }])
      ).toMatchObject({ validateInvalid: 0, validateUnavailable: 1 });
    }
  });

  it('ignores a failed tool call when the chained validate reported a valid config', () => {
    expect(
      count([
        {
          command: 'python3 edit.py && supabase config validate',
          failed: true,
          output:
            '{"valid":true,"errors":[]}\n/bin/bash: line 2: python3: command not found',
        },
        { command: 'supabase config validate', output: 'Config is valid.' },
      ])
    ).toMatchObject({ validateRuns: 2, validateInvalid: 0 });
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

  it('strips trailing comments like the CLI dotenv parser', () => {
    expect(
      parseEnvFile(
        'A=x # note\nB="y # kept" # note\nC=a#b\nD=\'z\' # n\nE=  # only\n'
      )
    ).toEqual({ A: 'x', B: 'y # kept', C: 'a#b', D: 'z', E: '' });
  });
});
