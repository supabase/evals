// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-006-fix-failing-pgtap-suite
import { describe, expect, it } from 'vitest';
import type { PgProveSummary, TestDbRun } from '../lib/pgtap.js';
import { checkSuitePassedUnderTestDb, TEST_DB_CHECK } from './test-db.js';

const SEEDED_FILES = 2;

const summary = (
  result: PgProveSummary['result'],
  files: number | null,
  tests: number | null
): PgProveSummary => ({ result, files, tests });

const run = (
  commandIndex: number,
  value: PgProveSummary | null,
  withPgProve?: true
): TestDbRun => ({
  commandIndex,
  summary: value,
  ...(withPgProve === undefined ? {} : { withPgProve }),
});

const PASS_ALL = summary('PASS', 2, 9);
const FAIL_ALL = summary('FAIL', 2, 6);
const PASS_ONE = summary('PASS', 1, 4);

const check = (runs: TestDbRun[], seededFileCount = SEEDED_FILES) =>
  checkSuitePassedUnderTestDb(runs, seededFileCount);

describe('checkSuitePassedUnderTestDb', () => {
  it('keeps the check name stable for the results dashboard', () => {
    expect(TEST_DB_CHECK).toBe('the whole suite passed under supabase test db');
  });

  describe('passing', () => {
    it('passes on a single run that printed Result: PASS for every seeded file, naming the command', () => {
      expect(check([run(3, PASS_ALL)])).toEqual({
        name: TEST_DB_CHECK,
        passed: true,
        notes: 'command 4 printed Result: PASS (Files=2, Tests=9)',
      });
    });

    it('passes when a failing run was followed by the passing one', () => {
      expect(
        check([run(1, FAIL_ALL), run(4, FAIL_ALL), run(6, PASS_ALL)])
      ).toEqual({
        name: TEST_DB_CHECK,
        passed: true,
        notes: 'command 7 printed Result: PASS (Files=2, Tests=9)',
      });
    });

    it('passes when the agent added a test file, so the suite is bigger than the seeded one', () => {
      expect(check([run(0, summary('PASS', 3, 11))])).toEqual({
        name: TEST_DB_CHECK,
        passed: true,
        notes: 'command 1 printed Result: PASS (Files=3, Tests=11)',
      });
    });

    it('passes when a later single-file run also passed, crediting the whole-suite run', () => {
      expect(check([run(2, PASS_ALL), run(5, PASS_ONE)])).toEqual({
        name: TEST_DB_CHECK,
        passed: true,
        notes: 'command 3 printed Result: PASS (Files=2, Tests=9)',
      });
    });

    it('passes when the last whole-suite run passed after an earlier one failed', () => {
      const result = check([
        run(0, FAIL_ALL),
        run(1, PASS_ALL),
        run(2, FAIL_ALL),
        run(3, PASS_ALL),
      ]);

      expect(result.passed).toBe(true);
      expect(result.notes).toBe(
        'command 4 printed Result: PASS (Files=2, Tests=9)'
      );
    });

    it('ignores runs that printed no summary around the passing one', () => {
      expect(check([run(0, null), run(1, PASS_ALL), run(2, null)]).passed).toBe(
        true
      );
    });

    it('measures the file count against the seeded count it is given', () => {
      expect(check([run(0, summary('PASS', 3, 11))], 3).passed).toBe(true);
    });
  });

  describe('never ran', () => {
    it('fails when supabase test db was never run', () => {
      expect(check([])).toEqual({
        name: TEST_DB_CHECK,
        passed: false,
        notes: 'supabase test db was never run',
      });
    });
  });

  describe('printed no summary', () => {
    it('fails when the only run printed no pg_prove summary', () => {
      expect(check([run(2, null)])).toEqual({
        name: TEST_DB_CHECK,
        passed: false,
        notes: '1 supabase test db run(s) printed no pg_prove summary',
      });
    });

    it('counts every run that printed no summary', () => {
      expect(check([run(0, null), run(4, null), run(5, null)]).notes).toBe(
        '3 supabase test db run(s) printed no pg_prove summary'
      );
    });

    it('names the commands that also ran pg_prove by hand, since either could have printed the summary', () => {
      expect(check([run(1, null, true)])).toEqual({
        name: TEST_DB_CHECK,
        passed: false,
        notes:
          '1 supabase test db run(s) printed no pg_prove summary; command(s) 2 also ran pg_prove by hand',
      });
    });

    it('lists each by-hand command, numbering from one', () => {
      expect(
        check([run(0, null, true), run(3, null), run(6, null, true)]).notes
      ).toBe(
        '3 supabase test db run(s) printed no pg_prove summary; command(s) 1, 7 also ran pg_prove by hand'
      );
    });
  });

  describe('never passed the whole suite', () => {
    it('fails when the only summary was a failure, naming the summary and command', () => {
      expect(check([run(2, FAIL_ALL)])).toEqual({
        name: TEST_DB_CHECK,
        passed: false,
        notes:
          'no supabase test db run passed the whole suite (last summary: FAIL (Files=2, Tests=6), command 3)',
      });
    });

    it('names the last run that printed a summary, not a later one that printed none', () => {
      expect(check([run(0, summary('FAIL', 2, 6)), run(1, null)]).notes).toBe(
        'no supabase test db run passed the whole suite (last summary: FAIL (Files=2, Tests=6), command 1)'
      );
    });

    it('fails when every run failed, naming the last one', () => {
      expect(
        check([run(0, summary('FAIL', 2, 6)), run(3, summary('FAIL', 1, 1))])
          .notes
      ).toBe(
        'no supabase test db run passed the whole suite (last summary: FAIL (Files=1, Tests=1), command 4)'
      );
    });

    it('fails on a PASS that ran zero tests', () => {
      expect(check([run(0, summary('PASS', 2, 0))]).passed).toBe(false);
    });

    it('fails on a PASS with no file count', () => {
      expect(check([run(0, summary('PASS', null, 9))]).passed).toBe(false);
    });

    it('says a PASS with no Files= count cannot be credited, naming the command', () => {
      expect(check([run(2, summary('PASS', null, null))])).toEqual({
        name: TEST_DB_CHECK,
        passed: false,
        notes:
          "command 3 printed Result: PASS without a Files= count, so it can't be credited with the whole suite",
      });
    });

    it('names the latest PASS without a Files= count, not an earlier failure', () => {
      expect(
        check([
          run(0, FAIL_ALL),
          run(1, summary('PASS', null, null)),
          run(2, FAIL_ALL),
        ]).notes
      ).toBe(
        "command 2 printed Result: PASS without a Files= count, so it can't be credited with the whole suite"
      );
    });

    it('prefers the latest PASS with no Files= count over an earlier single-file PASS', () => {
      expect(
        check([run(0, PASS_ONE), run(1, summary('PASS', null, null))]).notes
      ).toBe(
        "command 2 printed Result: PASS without a Files= count, so it can't be credited with the whole suite"
      );
    });

    it('keeps the last-summary note when a run with no Files= count printed a failure', () => {
      expect(check([run(1, summary('FAIL', null, null))])).toEqual({
        name: TEST_DB_CHECK,
        passed: false,
        notes:
          'no supabase test db run passed the whole suite (last summary: FAIL, command 2)',
      });
    });

    it('keeps the last-summary note when a PASS ran zero tests', () => {
      expect(check([run(0, summary('PASS', 2, 0))]).notes).toBe(
        'no supabase test db run passed the whole suite (last summary: PASS (Files=2, Tests=0), command 1)'
      );
    });

    it('reports the single-file PASS when it came after a PASS with no Files= count', () => {
      expect(
        check([run(0, summary('PASS', null, null)), run(1, PASS_ONE)]).notes
      ).toBe(
        'command 2 printed Result: PASS for 1 file(s); the seeded suite has 2'
      );
    });

    it('fails on a summary with no Result line', () => {
      expect(check([run(0, summary(null, 2, 9))]).passed).toBe(false);
    });
  });

  describe('passed fewer files than the seeded suite has', () => {
    it('fails, naming the command and both counts, when only one file ran and passed', () => {
      expect(check([run(4, PASS_ONE)])).toEqual({
        name: TEST_DB_CHECK,
        passed: false,
        notes:
          'command 5 printed Result: PASS for 1 file(s); the seeded suite has 2',
      });
    });

    it('fails when a failing whole-suite run was followed only by a single-file pass', () => {
      expect(check([run(1, FAIL_ALL), run(2, PASS_ONE)])).toEqual({
        name: TEST_DB_CHECK,
        passed: false,
        notes:
          'command 3 printed Result: PASS for 1 file(s); the seeded suite has 2',
      });
    });

    it('measures against the seeded count it is given', () => {
      expect(check([run(0, summary('PASS', 2, 9))], 3)).toMatchObject({
        passed: false,
        notes:
          'command 1 printed Result: PASS for 2 file(s); the seeded suite has 3',
      });
    });
  });

  describe('failed after passing', () => {
    it('fails when a later run printed Result: FAIL, naming both commands', () => {
      expect(check([run(1, PASS_ALL), run(4, FAIL_ALL)])).toEqual({
        name: TEST_DB_CHECK,
        passed: false,
        notes:
          'command 5 printed Result: FAIL after the passing run in command 2',
      });
    });

    it('fails when the later failure came from a single-file run', () => {
      expect(
        check([run(0, PASS_ALL), run(1, summary('FAIL', 1, 4))])
      ).toMatchObject({
        passed: false,
        notes:
          'command 2 printed Result: FAIL after the passing run in command 1',
      });
    });

    it('fails on a failing run even when later runs printed no summary', () => {
      expect(
        check([run(0, PASS_ALL), run(1, FAIL_ALL), run(2, null)]).passed
      ).toBe(false);
    });
  });
});
