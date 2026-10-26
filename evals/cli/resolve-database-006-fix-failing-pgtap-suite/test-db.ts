import type { CheckResult } from '@supabase-evals/core';
import {
  describePgProveSummary,
  type PgProveSummary,
  type TestDbRun,
} from '../lib/pgtap.js';

type SummarisedRun = TestDbRun & { summary: PgProveSummary };

export const TEST_DB_CHECK = 'the whole suite passed under supabase test db';

const hasSummary = (run: TestDbRun): run is SummarisedRun =>
  run.summary !== null;

const isPassing = ({ result, files, tests }: PgProveSummary) =>
  result === 'PASS' && files !== null && (tests ?? 0) > 0;

/** Passes when a `supabase test db` run printed `Result: PASS` for at least the seeded number of files and no later run printed `Result: FAIL`. */
export function checkSuitePassedUnderTestDb(
  runs: readonly TestDbRun[],
  seededFileCount: number
): CheckResult {
  const name = TEST_DB_CHECK;
  const fail = (notes: string): CheckResult => ({
    name,
    passed: false,
    notes,
  });
  if (runs.length === 0) return fail('supabase test db was never run');

  const summarised = runs.filter(hasSummary);
  const last = summarised.at(-1);
  if (last === undefined) {
    const byHand = runs
      .filter((run) => run.withPgProve)
      .map((run) => run.commandIndex + 1);
    return fail(
      `${runs.length} supabase test db run(s) printed no pg_prove summary${
        byHand.length === 0
          ? ''
          : `; command(s) ${byHand.join(', ')} also ran pg_prove by hand`
      }`
    );
  }

  const passing = summarised.filter((run) => isPassing(run.summary));
  const wholeSuite = passing
    .filter((run) => (run.summary.files ?? 0) >= seededFileCount)
    .at(-1);
  if (wholeSuite === undefined) {
    const lastPass = summarised
      .filter((run) => run.summary.result === 'PASS')
      .at(-1);
    if (lastPass?.summary.files === null) {
      return fail(
        `command ${lastPass.commandIndex + 1} printed Result: PASS without a Files= count, so it can't be credited with the whole suite`
      );
    }
    const partial = passing.at(-1);
    return fail(
      partial === undefined
        ? `no supabase test db run passed the whole suite (last summary: ${describePgProveSummary(last.summary)}, command ${last.commandIndex + 1})`
        : `command ${partial.commandIndex + 1} printed Result: PASS for ${partial.summary.files} file(s); the seeded suite has ${seededFileCount}`
    );
  }

  const failedAfter = summarised
    .filter(
      (run) =>
        run.commandIndex > wholeSuite.commandIndex &&
        run.summary.result === 'FAIL'
    )
    .at(-1);
  if (failedAfter !== undefined) {
    return fail(
      `command ${failedAfter.commandIndex + 1} printed Result: FAIL after the passing run in command ${wholeSuite.commandIndex + 1}`
    );
  }
  return {
    name,
    passed: true,
    notes: `command ${wholeSuite.commandIndex + 1} printed Result: PASS (Files=${wholeSuite.summary.files}, Tests=${wholeSuite.summary.tests})`,
  };
}
