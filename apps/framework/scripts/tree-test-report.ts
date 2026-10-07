/**
 * Summarizes tree test runs as markdown tables: each tree's success,
 * directness, first clicks, and path length, overall, for operator tasks, by
 * area, and per task.
 *
 * Usage: pnpm tree-test-report
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
  areaOf,
  HOLDOUT_TASKS,
  isOperator,
  SUMMARY_HEADERS,
  summarize,
  summaryCells,
  type TaskRun,
} from '../../../evals/docs-tree-tests/lib/summary.js';
import {
  FOUND_CHECK,
  type TreeTestRun,
} from '../../../evals/docs-tree-tests/lib/tree-test.js';
import { collectResultFiles, ROOT } from '../lib/result-files.js';

const files = await collectResultFiles({
  includeExperiment: (name) => name.includes('-tree-'),
});

const targetsByEval = new Map<string, string[]>();
const runsByTree = new Map<string, TaskRun[]>();
for (const { result, sourcePath } of files) {
  const [experiment, evalId] = sourcePath.split('/');
  const notes = result.checks?.find(
    (check) => check.name === FOUND_CHECK
  )?.notes;
  if (!notes) continue;
  if (!targetsByEval.has(evalId)) {
    const mod = await import(
      pathToFileURL(join(ROOT, 'evals/docs-tree-tests', evalId, 'EVAL.ts')).href
    );
    targetsByEval.set(evalId, mod.TARGETS);
  }
  const run: TreeTestRun = JSON.parse(notes);
  const tree = experiment.replace(/^.*-tree-/, '');
  runsByTree.set(tree, [
    ...(runsByTree.get(tree) ?? []),
    { evalId, targets: targetsByEval.get(evalId) ?? [], run },
  ]);
}

if (runsByTree.size === 0) {
  console.error('No tree test results under results/.');
  process.exit(1);
}

const trees = [...runsByTree.keys()].sort();
const table = (headers: string[], rows: string[][]) =>
  [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');

const groups: [string, (run: TaskRun) => boolean][] = [
  ['All tasks', () => true],
  ['Design tasks', (run) => !HOLDOUT_TASKS.includes(run.evalId)],
  ['Holdout tasks', (run) => HOLDOUT_TASKS.includes(run.evalId)],
  ['Operator tasks', (run) => isOperator(areaOf(run.targets))],
  ['Other tasks', (run) => !isOperator(areaOf(run.targets))],
];
for (const [title, include] of groups) {
  console.log(`\n### ${title}\n`);
  console.log(
    table(
      ['Tree', ...SUMMARY_HEADERS],
      trees.map((tree) => [
        tree,
        ...summaryCells(
          summarize(
            (runsByTree.get(tree) ?? [])
              .filter((run) => include(run))
              .map((run) => run.run)
          )
        ),
      ])
    )
  );
}

const areas = [
  ...new Set([...targetsByEval.values()].map((targets) => areaOf(targets))),
].sort();
console.log('\n### Success by area\n');
console.log(
  table(
    ['Area', ...trees],
    areas.map((area) => [
      area,
      ...trees.map((tree) => {
        const summary = summarize(
          (runsByTree.get(tree) ?? [])
            .filter((run) => areaOf(run.targets) === area)
            .map((run) => run.run)
        );
        return `${summary.success}/${summary.runs}`;
      }),
    ])
  )
);

console.log('\n### Per task: success, direct, median clicks\n');
console.log(
  table(
    ['Task', ...trees],
    [...targetsByEval.keys()].sort().map((evalId) => [
      evalId,
      ...trees.map((tree) => {
        const summary = summarize(
          (runsByTree.get(tree) ?? [])
            .filter((run) => run.evalId === evalId)
            .map((run) => run.run)
        );
        return `${summary.success}/${summary.runs}, ${summary.directSuccess} direct, ${summary.medianPath ?? '–'}`;
      }),
    ])
  )
);
