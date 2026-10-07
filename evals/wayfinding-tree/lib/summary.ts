import {
  indexTree,
  loadTree,
} from '../../../experiments/docs/lib/docs-tree.js';
import type { Severity } from '../../wayfinding/lib/wayfinding.js';
import type { TreeTestRun } from './tree-test.js';

/** Docs sections the wayfinding evals found weakest: operator territory. */
export const OPERATOR_SECTIONS = [
  'Platform Management',
  'Security & Compliance',
  'Deployment & Branching',
  'Observability',
];

export type TaskRun = { evalId: string; targets: string[]; run: TreeTestRun };

export type Summary = {
  runs: number;
  success: number;
  directSuccess: number;
  firstClickCorrect: number;
  /** Median path length of successful runs. */
  medianPath: number | null;
  severity: Record<Severity, number>;
};

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function summarize(runs: TreeTestRun[]): Summary {
  const severity: Record<Severity, number> = {
    clean: 0,
    friction: 0,
    failure: 0,
    'big failure': 0,
  };
  for (const run of runs) severity[run.severity]++;
  return {
    runs: runs.length,
    success: runs.filter((run) => run.success).length,
    directSuccess: runs.filter((run) => run.outcome === 'direct success')
      .length,
    firstClickCorrect: runs.filter((run) => run.firstClick?.correct).length,
    medianPath: median(
      runs.filter((run) => run.success).map((run) => run.pathLength)
    ),
    severity,
  };
}

const today = indexTree(loadTree('today'));

/**
 * Where a task's first target lives in today's docs: its top nav area and
 * section, like `Manage > Platform Management`. Proposals move pages, so tasks
 * are grouped by where they live today.
 */
export function areaOf(targets: string[]): string {
  for (const target of targets) {
    const node = today.find((candidate) => candidate.page === target);
    if (node) return node.trail.slice(0, 2).join(' > ');
  }
  return 'not in the navigation';
}

export const isOperator = (area: string) =>
  OPERATOR_SECTIONS.some((section) => area.endsWith(section));

const pct = (part: number, whole: number) =>
  whole ? `${Math.round((100 * part) / whole)}%` : '–';

/** One summary as a markdown table row. */
export function summaryCells(summary: Summary): string[] {
  return [
    `${summary.success}/${summary.runs} (${pct(summary.success, summary.runs)})`,
    pct(summary.directSuccess, summary.runs),
    pct(summary.firstClickCorrect, summary.runs),
    summary.medianPath === null ? '–' : `${summary.medianPath}`,
    `${summary.severity['big failure']}`,
  ];
}

export const SUMMARY_HEADERS = [
  'Success',
  'Direct success',
  'First click right',
  'Median clicks',
  'Big failures',
];
