// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-auth-001-push-config-change
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import { extractCommandEntries } from '../lib/detours.js';
import { HOSTED_REF, shellCall } from './fixtures.js';
import { countConfigInvocations } from './metrics.js';
import { CONFIG_PUSH_CHECK_NAME, checkConfigPushed } from './push.js';

const countsOf = (...commands: string[]) =>
  countConfigInvocations(
    findSupabaseInvocations(extractCommandEntries(commands.map(shellCall)))
  );

describe('checkConfigPushed', () => {
  it('keeps the check name stable for the results dashboard', () => {
    expect(CONFIG_PUSH_CHECK_NAME).toBe('the agent ran supabase config push');
  });

  it.each([
    ['one push', 'supabase config push'],
    ['a push with --yes', 'supabase config push --yes'],
    [
      'a push through npx with a project ref',
      `npx supabase config push --project-ref ${HOSTED_REF}`,
    ],
  ])('passes with %s', (_, command) => {
    expect(checkConfigPushed(countsOf(command))).toEqual({
      name: CONFIG_PUSH_CHECK_NAME,
      passed: true,
    });
  });

  it('passes when a push follows a diff', () => {
    expect(
      checkConfigPushed(
        countsOf('supabase config diff', 'supabase config push')
      ).passed
    ).toBe(true);
  });

  it.each([
    ['no commands', []],
    ['only a config diff', ['supabase config diff']],
    ['only a config pull', ['supabase config pull']],
    [
      'a diff and a pull',
      ['supabase config diff', 'supabase config pull', 'supabase link'],
    ],
    [
      'a direct Management API call',
      [
        `curl -X PATCH https://api.supabase.com/v1/projects/${HOSTED_REF}/config/auth -d '{"password_min_length":10}'`,
      ],
    ],
  ])('fails with %s', (_, commands) => {
    expect(checkConfigPushed(countsOf(...commands))).toEqual({
      name: CONFIG_PUSH_CHECK_NAME,
      passed: false,
      notes: 'no supabase config push ran',
    });
  });

  it('only reads configPush from the counts', () => {
    expect(checkConfigPushed({ configPush: 2 }).passed).toBe(true);
    expect(checkConfigPushed({ configPush: 0 }).passed).toBe(false);
  });
});
