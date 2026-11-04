import type { Navigation } from './navigation.js';

export interface CaseRun {
  navigation: Navigation;
  grounded: boolean;
}

export type ArmRuns = Record<string, CaseRun[]>;

export interface ArmTotals {
  cases: number;
  noWrongTurns: number;
  reached: number;
}

function isReached(run: CaseRun): boolean {
  return run.navigation.reached;
}

function hasNoWrongTurns(run: CaseRun): boolean {
  return run.navigation.noWrongTurns;
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
    noWrongTurns: runsByCase.filter((runs) =>
      mostRuns(runs, (run) => hasNoWrongTurns(run))
    ).length,
    reached: runsByCase.filter((runs) =>
      mostRuns(runs, (run) => isReached(run))
    ).length,
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
    `no wrong turns ${count(runs, (run) => hasNoWrongTurns(run))}/${runs.length}`,
    `reached ${reached.length}/${runs.length}`,
    `${median(hops)} hops`,
    `${count(runs, (run) => run.navigation.judged)} judged`,
    `${blocked} blocked`,
    `grounded ${count(runs, (run) => run.grounded)}/${runs.length}`,
  ].join(', ');
}

function groupCell(runs: CaseRun[]): string {
  if (runs.length === 0) return 'no runs';
  const clean = count(runs, (run) => hasNoWrongTurns(run));
  return `${clean}/${runs.length} (${Math.round((clean / runs.length) * 100)}%)`;
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
  const runsOf = (arm: string) => Object.values(arms[arm] ?? {}).flat();
  const groups = [
    ...new Set(
      armNames.flatMap((arm) =>
        runsOf(arm).map((run) => run.navigation.group ?? 'ungrouped')
      )
    ),
  ].sort();
  const table = [
    row(['Case', ...armNames]),
    row(['---', ...armNames.map(() => '---')]),
    ...caseIds.map((id) =>
      row([id, ...armNames.map((arm) => cell(arms[arm]?.[id]))])
    ),
    row([
      'Cases with no wrong turns, reached',
      ...armNames.map(
        (arm) =>
          `${totals[arm].noWrongTurns}/${totals[arm].cases}, ${totals[arm].reached}/${totals[arm].cases}`
      ),
    ]),
    ...groups.map((group) =>
      row([
        `Runs with no wrong turns, ${group}`,
        ...armNames.map((arm) =>
          groupCell(
            runsOf(arm).filter(
              (run) => (run.navigation.group ?? 'ungrouped') === group
            )
          )
        ),
      ])
    ),
  ].join('\n');
  return { table, totals };
}
