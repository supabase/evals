import type { Navigation } from './navigation.js';

export interface CaseRun {
  navigation: Navigation;
  grounded: boolean;
}

export type ArmRuns = Record<string, CaseRun[]>;

export interface ArmTotals {
  cases: number;
  reached: number;
  direct: number;
}

function isReached(run: CaseRun): boolean {
  return run.navigation.severity !== 'big failure';
}

function isDirect(run: CaseRun): boolean {
  return isReached(run) && run.navigation.direct;
}

function count(runs: CaseRun[], test: (run: CaseRun) => boolean): number {
  return runs.filter((run) => test(run)).length;
}

function mostRuns(runs: CaseRun[], test: (run: CaseRun) => boolean): boolean {
  return count(runs, test) * 2 > runs.length;
}

function totalsOf(cases: ArmRuns): ArmTotals {
  const runsByCase = Object.values(cases);
  return {
    cases: runsByCase.length,
    reached: runsByCase.filter((runs) =>
      mostRuns(runs, (run) => isReached(run))
    ).length,
    direct: runsByCase.filter((runs) => mostRuns(runs, (run) => isDirect(run)))
      .length,
  };
}

function median(values: number[]): string {
  if (values.length === 0) return '–';
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return `${sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2}`;
}

function cell(runs: CaseRun[] | undefined): string {
  if (!runs?.length) return 'no runs';
  const reached = runs.filter((run) => isReached(run));
  const hops = reached
    .map((run) => run.navigation.hopsToTarget)
    .filter((hop): hop is number => hop !== null);
  const blocked = runs.reduce(
    (sum, run) => sum + run.navigation.blockedJumps.length,
    0
  );
  return [
    `reached ${reached.length}/${runs.length}`,
    `direct ${count(runs, (run) => isDirect(run))}/${runs.length}`,
    `${median(hops)} hops`,
    `${count(runs, (run) => run.navigation.judged)} judged`,
    `${blocked} blocked`,
    `grounded ${count(runs, (run) => run.grounded)}/${runs.length}`,
  ].join(', ');
}

function row(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

export function buildReport(arms: Record<string, ArmRuns>) {
  const armNames = Object.keys(arms);
  const totals = Object.fromEntries(
    Object.entries(arms).map(([arm, cases]) => [arm, totalsOf(cases)])
  );
  const caseIds = [
    ...new Set(Object.values(arms).flatMap((cases) => Object.keys(cases))),
  ].sort();
  const origins = [
    ...new Set(
      Object.values(arms)
        .flatMap((cases) => Object.values(cases).flat())
        .map((run) => run.navigation.docsOrigin)
        .filter((origin): origin is string => origin !== null)
    ),
  ].sort();
  const table = [
    row(['Case', ...armNames]),
    row(['---', ...armNames.map(() => '---')]),
    ...caseIds.map((id) =>
      row([id, ...armNames.map((arm) => cell(arms[arm]?.[id]))])
    ),
    row([
      'Cases reached, direct',
      ...armNames.map(
        (arm) =>
          `${totals[arm].reached}/${totals[arm].cases}, ${totals[arm].direct}/${totals[arm].cases}`
      ),
    ]),
    '',
    `Docs origins: ${origins.join(', ')}`,
  ].join('\n');
  return { table, totals };
}
