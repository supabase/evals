import {
  indexTree,
  loadTree,
} from '../../../experiments/docs/lib/docs-tree.js';
import type { Severity } from '../../docs-wayfinding/lib/wayfinding.js';
import type { TreeTestRun } from './tree-test.js';

/** Docs sections the wayfinding evals found weakest: operator territory. */
export const OPERATOR_SECTIONS = [
  'Platform Management',
  'Security & Compliance',
  'Deployment & Branching',
  'Observability',
];

/**
 * Tasks held out from tree design: about a quarter of each area. Revise a
 * tree from the other tasks' results, and read these only in totals, so the
 * holdout shows whether a tree works beyond the tasks it was tuned on.
 */
export const HOLDOUT_TASKS = [
  'build-tree-007-existing-react-app',
  'build-tree-029-repo-instructions-for-assistant',
  'build-tree-033-auto-protect-new-tables',
  'build-tree-040-role-in-login-token',
  'build-tree-044-verify-user-in-go-api',
  'build-tree-051-push-row-updates-at-scale',
  'build-tree-056-keep-working-after-response',
  'build-tree-057-new-row-calls-function',
  'build-tree-059-chatbot-only-users-documents',
  'build-tree-061-local-oauth-credentials-gitignored',
  'deploy-tree-012-shared-responsibility',
  'deploy-tree-014-office-ip-allowlist',
  'deploy-tree-019-project-transfer',
  'deploy-tree-023-soc2-report',
  'deploy-tree-066-docker-install-catch-up-release',
  'deploy-tree-069-freelancer-single-app-membership',
  'deploy-tree-076-newer-postgres-major-version',
  'deploy-tree-079-outside-firm-attack-rules',
  'deploy-tree-083-prometheus-scrape-database-stats',
  'investigate-tree-060-nightly-purge-did-not-run',
  'resolve-tree-038-tables-outside-public-client',
  'resolve-tree-048-replaced-avatar-still-old',
  'resolve-tree-071-revive-inactive-free-app',
  'resolve-tree-087-serverless-too-many-clients',
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
