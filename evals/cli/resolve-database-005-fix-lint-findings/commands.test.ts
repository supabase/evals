// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-005-fix-lint-findings
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import {
  checkRanDatabaseChecks,
  countDatabaseCheckRuns,
  RAN_CHECKS_CHECK,
} from './commands.js';

const countsOf = (...commands: string[]) =>
  countDatabaseCheckRuns(findSupabaseInvocations(commands));

describe('countDatabaseCheckRuns', () => {
  it.each([
    ['supabase db lint', { lint: 1, advisors: 0 }],
    ['supabase db lint --level error', { lint: 1, advisors: 0 }],
    [
      'supabase db lint --level warning --fail-on error',
      { lint: 1, advisors: 0 },
    ],
    ['npx supabase db lint --local', { lint: 1, advisors: 0 }],
    ['supabase --workdir /ws db lint', { lint: 1, advisors: 0 }],
    ['supabase db advisors', { lint: 0, advisors: 1 }],
    ['npx supabase db advisors --local', { lint: 0, advisors: 1 }],
    [
      'supabase db advisors --type security --level warn',
      { lint: 0, advisors: 1 },
    ],
  ])('counts %j as %j', (command, expected) => {
    expect(countsOf(command)).toEqual(expected);
  });

  it('counts each run of each command', () => {
    expect(
      countsOf(
        'supabase db lint',
        'npx supabase db advisors --local',
        'supabase db lint --level error',
        'supabase db advisors --type performance'
      )
    ).toEqual({ lint: 2, advisors: 2 });
  });

  it.each([
    'supabase db reset',
    'supabase migration list',
    'supabase migration up',
    'supabase db query "select 1"',
    'supabase db diff -f fix',
    'supabase db push --local',
    'supabase start',
    'psql "$DATABASE_URL" -c "select 1"',
  ])('does not count %j', (command) => {
    expect(countsOf(command)).toEqual({ lint: 0, advisors: 0 });
  });

  it('does not count a command that only echoes the invocation', () => {
    expect(countsOf('echo "supabase db lint"')).toEqual({
      lint: 0,
      advisors: 0,
    });
  });

  it('counts only the check runs among other supabase commands', () => {
    expect(
      countsOf(
        'supabase start',
        'supabase db advisors',
        'supabase db reset',
        'supabase migration list',
        'supabase db lint'
      )
    ).toEqual({ lint: 1, advisors: 1 });
  });

  it('is zero when the agent ran nothing', () => {
    expect(countDatabaseCheckRuns([])).toEqual({ lint: 0, advisors: 0 });
  });
});

describe('checkRanDatabaseChecks', () => {
  it('keeps the check name stable for the results dashboard', () => {
    expect(RAN_CHECKS_CHECK).toBe('ran supabase db lint or db advisors');
  });

  it.each([
    [{ lint: 1, advisors: 0 }, 'db lint ×1, db advisors ×0'],
    [{ lint: 0, advisors: 1 }, 'db lint ×0, db advisors ×1'],
    [{ lint: 3, advisors: 2 }, 'db lint ×3, db advisors ×2'],
  ])('passes with %j', (counts, notes) => {
    expect(checkRanDatabaseChecks(counts)).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: true,
      notes,
    });
  });

  it('fails when neither check ran', () => {
    expect(checkRanDatabaseChecks({ lint: 0, advisors: 0 })).toEqual({
      name: RAN_CHECKS_CHECK,
      passed: false,
      notes: 'db lint ×0, db advisors ×0',
    });
  });

  it('passes on lint alone and on advisors alone, never requiring both', () => {
    expect(checkRanDatabaseChecks(countsOf('supabase db lint')).passed).toBe(
      true
    );
    expect(
      checkRanDatabaseChecks(countsOf('npx supabase db advisors --local'))
        .passed
    ).toBe(true);
  });

  it('fails when the agent only reset the database and listed migrations', () => {
    expect(
      checkRanDatabaseChecks(
        countsOf('supabase db reset', 'supabase migration list')
      ).passed
    ).toBe(false);
  });
});
