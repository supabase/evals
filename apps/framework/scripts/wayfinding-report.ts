/**
 * Summarizes wayfinding eval results as markdown tables: one row per eval,
 * then one row per IA problem area.
 *
 * Usage: pnpm wayfinding-report [--experiment claude-code-sonnet-5-wayfinding]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WayfindingResult } from '@supabase-evals/core';
import { readRepeatedFlag } from '../lib/cli-args.js';
import { collectResultFiles, readPrompt, ROOT } from '../lib/result-files.js';

const REACHED_TARGET_CHECK = 'reached a target page';
const FACTS_CHECK = 'answer covers the key facts';
const experiment =
  readRepeatedFlag(process.argv.slice(2), 'experiment')[0] ??
  'claude-code-sonnet-5-wayfinding';

interface Run {
  wayfinding: WayfindingResult;
  factsPassed: boolean;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function spread(values: number[]): string {
  if (values.length === 0) return '–';
  const m = median(values);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? `${m}` : `${m} (${min}–${max})`;
}

function tally(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => `${value} ${count}`)
    .join(', ');
}

function summarize(runs: Run[]): string[] {
  const reached = runs.filter((run) => run.wayfinding.hopsToTarget !== null);
  return [
    `${reached.length}/${runs.length}`,
    spread(reached.map((run) => run.wayfinding.hopsToTarget as number)),
    spread(runs.map((run) => run.wayfinding.wrongPages.length)),
    `${runs.reduce((sum, run) => sum + run.wayfinding.notFound.length, 0)}`,
    tally(runs.map((run) => run.wayfinding.entrySurface)),
    tally(
      runs.flatMap((run) => run.wayfinding.fetches.map((f) => f.provenance))
    ),
    `${runs.filter((run) => run.factsPassed).length}/${runs.length}`,
  ];
}

const HEADER = [
  'Reached target',
  'Hops to target',
  'Wrong pages',
  '404s',
  'Entry surface',
  'How fetched urls were found',
  'Facts covered',
];

function table(label: string, rows: Array<[string, Run[]]>): string {
  const lines = [
    `| ${[label, ...HEADER].join(' | ')} |`,
    `| ${[label, ...HEADER].map(() => '---').join(' | ')} |`,
    ...rows.map(
      ([name, runs]) => `| ${[name, ...summarize(runs)].join(' | ')} |`
    ),
  ];
  return lines.join('\n');
}

/** The IA problem an eval covers, from the `motivation` in its PROMPT.md. */
async function areaOf(evalId: string): Promise<string> {
  const prompt = await readPrompt(evalId);
  if (!prompt) return 'unknown';
  const text = await readFile(join(ROOT, prompt.promptSourcePath), 'utf8');
  return text.match(/for the "([^"]+)" IA problem/)?.[1] ?? 'unknown';
}

const files = await collectResultFiles({
  includeExperiment: (name) => name === experiment,
  includeEval: (id) => id.includes('-wayfinding-'),
});

const byEval = new Map<string, Run[]>();
for (const { result, sourcePath } of files) {
  const evalId = sourcePath.split('/')[1];
  const checks = result.checks ?? [];
  const reached = checks.find((check) => check.name === REACHED_TARGET_CHECK);
  if (!reached?.notes) continue;
  const runs = byEval.get(evalId) ?? [];
  runs.push({
    wayfinding: JSON.parse(reached.notes) as WayfindingResult,
    factsPassed:
      checks.find((check) => check.name === FACTS_CHECK)?.passed ?? false,
  });
  byEval.set(evalId, runs);
}

if (byEval.size === 0) {
  console.error(`No wayfinding results for ${experiment} under results/.`);
  process.exit(1);
}

const byArea = new Map<string, Run[]>();
for (const [evalId, runs] of byEval) {
  const area = await areaOf(evalId);
  byArea.set(area, [...(byArea.get(area) ?? []), ...runs]);
}

const evalRows = [...byEval].sort(([a], [b]) =>
  a.replace(/^\w+-/, '').localeCompare(b.replace(/^\w+-/, ''))
);
console.log(`## Wayfinding: ${experiment}\n`);
console.log(
  'Hops and wrong pages are the median, with the range in parentheses.\n'
);
console.log(`${table('Area', [...byArea])}\n`);
console.log(table('Eval', evalRows));
