import type { CheckResult } from '@supabase-evals/core';
import {
  describePgProveSummary,
  type PgProveSummary,
  type TestDbRun,
} from '../lib/pgtap.js';

type SummaryEvent = {
  commandIndex: number;
  summary: PgProveSummary;
  wholeDirectory: boolean;
};

export const TEST_DB_CHECK = 'the whole suite passed under supabase test db';

const summaryEvents = (runs: readonly TestDbRun[]): SummaryEvent[] =>
  runs.flatMap(({ commandIndex, summaries, wholeDirectory }) =>
    summaries.map((summary) => ({
      commandIndex,
      summary,
      wholeDirectory: wholeDirectory === true,
    }))
  );

const isPass = ({ result, tests }: PgProveSummary) =>
  result === 'PASS' && tests !== 0;

const isWholeSuitePass = (event: SummaryEvent, seededFileCount: number) =>
  isPass(event.summary) &&
  (event.summary.files === null
    ? event.wholeDirectory
    : event.summary.files >= seededFileCount);

const failedFileCount = (event: SummaryEvent, seededFileCount: number) =>
  event.summary.files ?? (event.wholeDirectory ? seededFileCount : 1);

const clears = (
  pass: PgProveSummary,
  fail: SummaryEvent,
  seededFileCount: number
) =>
  isPass(pass) &&
  pass.files !== null &&
  pass.files >= failedFileCount(fail, seededFileCount);

/** Passes when a `supabase test db` summary printed `Result: PASS` for the whole suite and every later `Result: FAIL`, in the same call or a later one, was followed by a pass covering at least as many files. */
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

  const events = summaryEvents(runs);
  const last = events.at(-1);
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

  const wholeSuite = events
    .filter((event) => isWholeSuitePass(event, seededFileCount))
    .at(-1);
  if (wholeSuite === undefined) {
    const lastPass = events
      .filter((event) => event.summary.result === 'PASS')
      .at(-1);
    if (lastPass?.summary.files === null) {
      return fail(
        `command ${lastPass.commandIndex + 1} printed Result: PASS without a Files= count, so it can't be credited with the whole suite`
      );
    }
    const partial = events
      .filter((event) => isPass(event.summary) && event.summary.files !== null)
      .at(-1);
    return fail(
      partial === undefined
        ? `no supabase test db run passed the whole suite (last summary: ${describePgProveSummary(last.summary)}, command ${last.commandIndex + 1})`
        : `command ${partial.commandIndex + 1} printed Result: PASS for ${partial.summary.files} file(s); the seeded suite has ${seededFileCount}`
    );
  }

  let unresolved: SummaryEvent[] = [];
  for (const event of events.slice(events.indexOf(wholeSuite) + 1)) {
    unresolved =
      event.summary.result === 'FAIL'
        ? [...unresolved, event]
        : unresolved.filter(
            (failed) => !clears(event.summary, failed, seededFileCount)
          );
  }
  const failedAfter = unresolved.at(-1);
  if (failedAfter !== undefined) {
    return fail(
      `command ${failedAfter.commandIndex + 1} printed Result: FAIL after the passing run in command ${wholeSuite.commandIndex + 1}`
    );
  }
  return {
    name,
    passed: true,
    notes: `command ${wholeSuite.commandIndex + 1} printed Result: ${describePgProveSummary(wholeSuite.summary)}`,
  };
}
