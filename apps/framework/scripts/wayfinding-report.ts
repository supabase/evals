/**
 * Summarizes wayfinding eval results as markdown tables: for each
 * experiment, one row per IA problem area and one per eval, then the arms
 * side by side per area.
 *
 * Rescores every run with the current `scoreWayfinding` and each eval's
 * exported `TARGETS` and `ALTERNATES`, so older runs get the same treatment
 * as new ones. It scores the tool calls as the agent saw them, from the
 * transcript: saved results have truncated search output rehydrated.
 *
 * Usage: pnpm wayfinding-report [--experiment <name>]...
 * Defaults to the navigation, counterfactual, memory, and closed-book arms.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildDocsResult,
  docsPath,
  scoreWayfinding,
  type ToolCallRecord,
  type TranscriptPart,
  type WayfindingResult,
} from '@supabase-evals/core';
import { readRepeatedFlag } from '../lib/cli-args.js';
import { collectResultFiles, readPrompt, ROOT } from '../lib/result-files.js';

const FACTS_CHECK = 'answer covers the key facts';
const ARMS = [
  'claude-code-sonnet-5-wayfinding-navigate',
  'claude-code-sonnet-5-wayfinding-navigate-linked',
  'claude-code-sonnet-5-wayfinding-browse',
  'claude-code-sonnet-5-wayfinding-closed-book',
];
const flagged = readRepeatedFlag(process.argv.slice(2), 'experiment');
const experiments = flagged.length > 0 ? flagged : ARMS;

interface Run {
  wayfinding: WayfindingResult;
  /** A search returned a target or alternate, whether or not the agent saw it. */
  searchReturnedTarget: boolean;
  factsPassed: boolean;
}

interface EvalTargets {
  targets: string[];
  alternates: string[];
}

const targetsByEval = new Map<string, Promise<EvalTargets>>();

function targetsOf(evalId: string): Promise<EvalTargets> {
  let targets = targetsByEval.get(evalId);
  if (!targets) {
    const path = join(ROOT, 'evals', 'wayfinding', evalId, 'EVAL.ts');
    targets = import(pathToFileURL(path).href).then((mod) => ({
      targets: mod.TARGETS ?? [],
      alternates: mod.ALTERNATES ?? [],
    }));
    targetsByEval.set(evalId, targets);
  }
  return targets;
}

/** The tool calls with each result as the agent saw it, from the transcript. */
function agentView(
  toolCalls: ToolCallRecord[],
  transcript: TranscriptPart[]
): ToolCallRecord[] {
  const outputs = transcript.filter((part) => part.type === 'tool_call');
  return toolCalls.map((call, index) => {
    const output = outputs[index]?.output;
    return output === undefined ? call : { ...call, result: output };
  });
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
  const viaAlternate = reached.filter(
    (run) => run.wayfinding.viaAlternate
  ).length;
  const searches = runs.flatMap((run) => run.wayfinding.searches);
  const truncated = searches.filter((search) => search.truncated);
  const searched = searches.length > 0;
  return [
    searched
      ? `${runs.filter((run) => run.searchReturnedTarget).length}/${runs.length}`
      : '–',
    `${reached.length}/${runs.length}${viaAlternate ? ` (${viaAlternate} via duplicate)` : ''}`,
    spread(reached.map((run) => run.wayfinding.hopsToTarget as number)),
    tally(runs.map((run) => run.wayfinding.severity)),
    `${runs.reduce((sum, run) => sum + run.wayfinding.blockedFetches.length, 0)}`,
    spread(runs.map((run) => run.wayfinding.otherPages.length)),
    `${runs.reduce((sum, run) => sum + run.wayfinding.notFound.length, 0)}`,
    searched
      ? `${truncated.length}/${searches.length} (${truncated.filter((search) => search.opened).length})`
      : '–',
    `${runs.reduce((sum, run) => sum + run.wayfinding.searchApiFetches.length, 0)}`,
    tally(runs.map((run) => run.wayfinding.entrySurface)),
    tally(
      runs.flatMap((run) => run.wayfinding.fetches.map((f) => f.provenance))
    ),
    `${runs.filter((run) => run.factsPassed).length}/${runs.length}`,
  ];
}

const HEADER = [
  'Search returned target',
  'Reached target',
  'Hops to target',
  'Severity',
  'Blocked memory jumps',
  'Other pages',
  '404s',
  'Searches truncated (opened)',
  'Search API fetches',
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

/** Every run of one experiment, rescored, by eval id. */
async function collectRuns(experiment: string): Promise<Map<string, Run[]>> {
  const files = await collectResultFiles({
    includeExperiment: (name) => name === experiment,
    includeEval: (id) => id.includes('-wayfinding-'),
  });
  const byEval = new Map<string, Run[]>();
  for (const { result, sourcePath } of files) {
    const evalId = sourcePath.split('/')[1];
    const checks = result.checks ?? [];
    const toolCalls = (result.toolCalls ?? []) as ToolCallRecord[];
    const transcript = (result.transcript ?? []) as TranscriptPart[];
    const { targets, alternates } = await targetsOf(evalId);
    const wanted = new Set([...targets, ...alternates]);
    const runs = byEval.get(evalId) ?? [];
    runs.push({
      wayfinding: await scoreWayfinding({
        toolCalls: agentView(toolCalls, transcript),
        targets,
        alternates,
      }),
      searchReturnedTarget: buildDocsResult(toolCalls).calls.some(
        (call) =>
          call.source === 'search_docs' &&
          call.pages.some((page) => wanted.has(docsPath(page.url) ?? ''))
      ),
      factsPassed:
        checks.find((check) => check.name === FACTS_CHECK)?.passed ?? false,
    });
    byEval.set(evalId, runs);
  }
  return byEval;
}

async function byArea(byEval: Map<string, Run[]>): Promise<Map<string, Run[]>> {
  const areas = new Map<string, Run[]>();
  for (const [evalId, runs] of byEval) {
    const area = await areaOf(evalId);
    areas.set(area, [...(areas.get(area) ?? []), ...runs]);
  }
  return areas;
}

/** Each arm's reach, hops, and facts side by side, per area. */
function comparison(arms: Array<[string, Map<string, Run[]>]>): string {
  const areas = [
    ...new Set(arms.flatMap(([, areaRuns]) => [...areaRuns.keys()])),
  ];
  const header = [
    'Area',
    ...arms.flatMap(([name]) => {
      const arm = name.replace(/^.*-wayfinding-/, '');
      return [
        `${arm}: reached`,
        `${arm}: hops`,
        `${arm}: big failures`,
        `${arm}: facts`,
      ];
    }),
  ];
  const rows = areas.map((area) => [
    area,
    ...arms.flatMap(([, areaRuns]) => {
      const runs = areaRuns.get(area) ?? [];
      const reached = runs.filter(
        (run) => run.wayfinding.hopsToTarget !== null
      );
      return [
        `${reached.length}/${runs.length}`,
        spread(reached.map((run) => run.wayfinding.hopsToTarget as number)),
        `${runs.filter((run) => run.wayfinding.severity === 'big failure').length}/${runs.length}`,
        `${runs.filter((run) => run.factsPassed).length}/${runs.length}`,
      ];
    }),
  ]);
  return [header, header.map(() => '---'), ...rows]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n');
}

const arms: Array<[string, Map<string, Run[]>]> = [];
for (const experiment of experiments) {
  const byEval = await collectRuns(experiment);
  if (byEval.size === 0) {
    console.error(`No wayfinding results for ${experiment} under results/.`);
    continue;
  }
  const areaRuns = await byArea(byEval);
  arms.push([experiment, areaRuns]);
  const evalRows = [...byEval].sort(([a], [b]) =>
    a.replace(/^\w+-/, '').localeCompare(b.replace(/^\w+-/, ''))
  );
  console.log(`## Wayfinding: ${experiment}\n`);
  console.log(
    'Hops and other pages are the median, with the range in parentheses.\n'
  );
  console.log(`${table('Area', [...areaRuns])}\n`);
  console.log(`${table('Eval', evalRows)}\n`);
}

if (arms.length === 0) process.exit(1);
if (arms.length > 1) {
  console.log('## Arms compared\n');
  console.log(comparison(arms));
}
