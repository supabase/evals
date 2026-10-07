// Compares tree test results across trees. Holdout tasks only show in totals.
// Usage: node --import tsx/esm analyze.mts <results.json>... [--detail tree] [--tasks]
import { readFileSync } from 'node:fs';
import {
  areaOf,
  isOperator,
  summarize,
  summaryCells,
  SUMMARY_HEADERS,
  HOLDOUT_TASKS,
} from '../evals/docs-tree-tests/lib/summary.ts';
import type { TreeTestRun } from '../evals/docs-tree-tests/lib/tree-test.ts';

type Row = { evalId: string; targets: string[]; result: TreeTestRun };
const args = process.argv.slice(2);
const detail = args.includes('--detail') ? args[args.indexOf('--detail') + 1] : null;
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--detail');

const byTree = new Map<string, Row[]>();
for (const file of files) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const tree = data.experiment.replace(/^.*-tree-/, '').replace(/@.*/, '');
  byTree.set(tree, [...(byTree.get(tree) ?? []), ...data.runs]);
}
const trees = [...byTree.keys()];
const holdout = new Set(HOLDOUT_TASKS);
const table = (headers: string[], rows: string[][]) =>
  [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

const groups: [string, (r: Row) => boolean][] = [
  ['All', () => true],
  ['Design set', (r) => !holdout.has(r.evalId)],
  ['Holdout', (r) => holdout.has(r.evalId)],
  ['Operator', (r) => isOperator(areaOf(r.targets))],
  ['Other', (r) => !isOperator(areaOf(r.targets))],
];
for (const [title, include] of groups) {
  console.log(`\n### ${title}`);
  console.log(table(['Tree', ...SUMMARY_HEADERS, 'Skips'], trees.map((t) => {
    const runs = byTree.get(t)!.filter(include).map((r) => r.result);
    return [t, ...summaryCells(summarize(runs)), `${runs.filter((r) => r.outcome === 'skip').length}`];
  })));
}

const areas = [...new Set([...byTree.values()].flat().map((r) => areaOf(r.targets)))].sort();
console.log('\n### Success by area (design set)');
console.log(table(['Area', ...trees], areas.map((area) => [area, ...trees.map((t) => {
  const s = summarize(byTree.get(t)!.filter((r) => !holdout.has(r.evalId) && areaOf(r.targets) === area).map((r) => r.result));
  return `${s.success}/${s.runs} (${s.directSuccess} direct)`;
})])));

if (args.includes('--tasks')) {
  const ids = [...new Set([...byTree.values()].flat().map((r) => r.evalId))].filter((id) => !holdout.has(id)).sort();
  console.log('\n### Design tasks: success/runs, direct');
  console.log(table(['Task', ...trees], ids.map((id) => [id, ...trees.map((t) => {
    const s = summarize(byTree.get(t)!.filter((r) => r.evalId === id).map((r) => r.result));
    return `${s.success}/${s.runs} ${s.directSuccess}d ${s.medianPath ?? '–'}c`;
  })])));
}

if (detail) {
  console.log(`\n### Failures and indirect runs in ${detail} (design set)`);
  const rows = byTree.get(detail)!.filter((r) => !holdout.has(r.evalId)).sort((a, b) => a.evalId.localeCompare(b.evalId));
  for (const r of rows) {
    if (r.result.outcome === 'direct success') continue;
    console.log(`- ${r.evalId} [${r.result.outcome}, ${r.result.pathLength} clicks] targets ${r.targets.join(', ')}`);
    console.log(`    path: ${r.result.opened.join(' → ')}`);
    console.log(`    chose: ${r.result.chosen ? `${r.result.chosen.trail} (${r.result.chosen.page})` : 'nothing'}`);
  }
}
