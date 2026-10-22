import type { CheckResult } from '@supabase-evals/core';
import { APP_READERS, type AppReader } from './fixtures.js';
import type { PhaseReport, ProbeReport, ReaderResult } from './probe.js';

export const LINT_CHECK =
  'db lint reports no errors or warnings in the project functions';
export const ADVISORS_CHECK = 'advisors no longer flag the seeded findings';
export const BEHAVIOUR_CHECK =
  'the app still reads only its own orders and totals';
export const REPLAY_CHECK =
  'replaying the migrations and seed reproduces the fixed database';

const TOTAL_TOLERANCE = 0.005;
const PERMISSION_DENIED = '42501';
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

export function checkLintClean(phase: PhaseReport): CheckResult {
  const name = LINT_CHECK;
  if (phase.lintError !== undefined) {
    return {
      name,
      passed: false,
      notes: `the lint probe failed: ${phase.lintError}`,
    };
  }
  if (!phase.lintDone) {
    return { name, passed: false, notes: 'the lint probe did not finish' };
  }
  const offending = phase.lint.filter(
    ({ level }) => level === 'error' || level.startsWith('warning')
  );
  return offending.length === 0
    ? { name, passed: true, notes: 'no lint errors or warnings' }
    : {
        name,
        passed: false,
        notes: offending
          .map((issue) => `${issue.function}: ${issue.level} ${issue.message}`)
          .join('; '),
      };
}

export function checkAdvisorsClean(phase: PhaseReport): CheckResult {
  const name = ADVISORS_CHECK;
  if (phase.advisorsError !== undefined) {
    return {
      name,
      passed: false,
      notes: `the advisor probe failed: ${phase.advisorsError}`,
    };
  }
  if (!phase.advisorsDone) {
    return { name, passed: false, notes: 'the advisor probe did not finish' };
  }
  return phase.advisors.length === 0
    ? { name, passed: true, notes: 'no advisor findings' }
    : {
        name,
        passed: false,
        notes: phase.advisors
          .map(({ name: finding, object }) => `${finding} on ${object}`)
          .join('; '),
      };
}

const shortSub = (sub: string | null) => `${(sub ?? 'unknown').slice(0, 4)}…`;

function parseTotals(totals: readonly string[]): number[] | undefined {
  if (!totals.every((total) => NUMERIC_RE.test(total))) return undefined;
  return totals.map(Number).sort((a, b) => a - b);
}

function sameTotals(actual: readonly string[], expected: readonly number[]) {
  const parsed = parseTotals(actual);
  const wanted = [...expected].sort((a, b) => a - b);
  return (
    parsed !== undefined &&
    parsed.length === wanted.length &&
    parsed.every((total, i) => Math.abs(total - wanted[i]) <= TOTAL_TOLERANCE)
  );
}

function describeFailedReader(reader: Extract<ReaderResult, { ok: false }>) {
  return `${reader.error} (${reader.sqlstate})`;
}

function checkUserReads(
  readers: readonly ReaderResult[],
  expected: AppReader
): string | undefined {
  const who = shortSub(expected.sub);
  const reader = readers.find(
    (candidate) =>
      candidate.role === 'authenticated' && candidate.sub === expected.sub
  );
  if (reader === undefined) return `${who}: no reader row`;
  if (!reader.ok) return `${who}: ${describeFailedReader(reader)}`;
  if (
    reader.orders === expected.orders &&
    reader.items === expected.items &&
    sameTotals(reader.totals, expected.totals)
  ) {
    return undefined;
  }
  return `${who}: reads ${reader.orders} orders, ${reader.items} order_items rows and totals [${reader.totals.join(', ')}], expected ${expected.orders}, ${expected.items} and [${expected.totals.join(', ')}]`;
}

function checkAnonReads(readers: readonly ReaderResult[]): string[] {
  const anon = readers.find(({ role }) => role === 'anon');
  if (anon === undefined) return ['no anon reader row'];
  if (!anon.ok) {
    return anon.sqlstate === PERMISSION_DENIED
      ? []
      : [`anon: ${describeFailedReader(anon)}`];
  }
  return [
    ...(anon.orders > 0 ? [`anon reads ${anon.orders} orders`] : []),
    ...(anon.items > 0 ? [`anon reads ${anon.items} order_items rows`] : []),
  ];
}

function describeTriggerFailure(
  trigger: PhaseReport['trigger']
): string | undefined {
  if (trigger === undefined) return 'updated_at trigger was not probed';
  if ('error' in trigger) return `updated_at trigger failed: ${trigger.error}`;
  if (trigger.stamped === null) {
    return 'updated_at trigger could not be checked: no row updated';
  }
  return trigger.stamped
    ? undefined
    : 'updated_at trigger did not stamp the row';
}

export function checkAppBehaviour(
  phase: PhaseReport,
  readers: readonly AppReader[] = APP_READERS
): CheckResult {
  const problems = [
    ...readers.map((expected) => checkUserReads(phase.readers, expected)),
    ...checkAnonReads(phase.readers),
    describeTriggerFailure(phase.trigger),
  ].filter((problem): problem is string => problem !== undefined);
  return problems.length === 0
    ? {
        name: BEHAVIOUR_CHECK,
        passed: true,
        notes: `${readers.length} users read only their own rows and totals, anon reads nothing, updated_at trigger stamps`,
      }
    : { name: BEHAVIOUR_CHECK, passed: false, notes: problems.join('; ') };
}

/** Reruns the three database checks on the database rebuilt from the migration files and seed. */
export function checkReplay(report: ProbeReport): CheckResult {
  const name = REPLAY_CHECK;
  const { replay, replayed } = report;
  if (replay === undefined) {
    return { name, passed: false, notes: 'replay did not run' };
  }
  if (!replay.ok) {
    return {
      name,
      passed: false,
      notes: `${replay.file}: ${replay.error} (${replay.sqlstate})`,
    };
  }
  const failing = [
    { aspect: 'lint', result: checkLintClean(replayed) },
    { aspect: 'advisors', result: checkAdvisorsClean(replayed) },
    { aspect: 'app behaviour', result: checkAppBehaviour(replayed) },
  ].filter(({ result }) => !result.passed);
  return failing.length === 0
    ? { name, passed: true, notes: `${replay.files} files replayed cleanly` }
    : {
        name,
        passed: false,
        notes: failing
          .map(({ aspect, result }) => `${aspect}: ${result.notes}`)
          .join('; '),
      };
}
