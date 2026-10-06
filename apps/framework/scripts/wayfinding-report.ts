/**
 * Summarizes wayfinding eval runs as one markdown table: each eval's reach,
 * hops, severity, blocked memory jumps, and facts, with and without the
 * proposed links.
 *
 * Usage: pnpm wayfinding-report
 */
import {
  type Navigation,
  REACHED_TARGET_CHECK,
} from '../../../evals/wayfinding/lib/wayfinding.js';
import { collectResultFiles } from '../lib/result-files.js';

const ARMS = {
  today: 'claude-code-sonnet-5-wayfinding-navigate',
  'proposed links': 'claude-code-sonnet-5-wayfinding-navigate-linked',
};
const FACTS_CHECK = 'answer covers the key facts';

type Run = { navigation: Navigation; factsPassed: boolean };

function median(values: number[]): string {
  if (values.length === 0) return '–';
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return `${sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2}`;
}

function summarize(runs: Run[] = []): string {
  if (runs.length === 0) return 'no runs';
  const reached = runs.filter((run) => run.navigation.hopsToTarget !== null);
  const big = runs.filter((run) => run.navigation.severity === 'big failure');
  const blocked = runs.reduce(
    (sum, run) => sum + run.navigation.blockedJumps.length,
    0
  );
  const facts = runs.filter((run) => run.factsPassed).length;
  return [
    `reached ${reached.length}/${runs.length}`,
    `${median(reached.map((run) => run.navigation.hopsToTarget as number))} hops`,
    `${big.length} big failures`,
    `${blocked} blocked jumps`,
    `facts ${facts}/${runs.length}`,
  ].join(', ');
}

const runs = new Map<string, Map<string, Run[]>>();
for (const [arm, experiment] of Object.entries(ARMS)) {
  const files = await collectResultFiles({
    includeExperiment: (name) => name === experiment,
  });
  for (const { result, sourcePath } of files) {
    const evalId = sourcePath.split('/')[1];
    const checks = result.checks ?? [];
    const reached = checks.find((check) => check.name === REACHED_TARGET_CHECK);
    if (!reached?.notes) continue;
    const byArm = runs.get(evalId) ?? new Map<string, Run[]>();
    byArm.set(arm, [
      ...(byArm.get(arm) ?? []),
      {
        navigation: JSON.parse(reached.notes),
        factsPassed:
          checks.find((check) => check.name === FACTS_CHECK)?.passed ?? false,
      },
    ]);
    runs.set(evalId, byArm);
  }
}

if (runs.size === 0) {
  console.error('No wayfinding results under results/.');
  process.exit(1);
}

const arms = Object.keys(ARMS);
console.log(`| Eval | ${arms.join(' | ')} |`);
console.log(`| --- | ${arms.map(() => '---').join(' | ')} |`);
for (const [evalId, byArm] of [...runs].sort(([a], [b]) =>
  a.localeCompare(b)
)) {
  console.log(
    `| ${evalId} | ${arms.map((arm) => summarize(byArm.get(arm))).join(' | ')} |`
  );
}
