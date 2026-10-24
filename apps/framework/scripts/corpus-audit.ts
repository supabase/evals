/**
 * Audit the three corpus experiments (full, none, gap): pass rate per
 * experiment, runs that reached the web or the docs search tool when they
 * should not have, and a per-eval pass table. Reads results/<experiment>/
 * <eval>/run-<n>/result.json; run it after `pnpm eval -- --experiment-suite corpus`.
 *
 *   pnpm corpus:audit [--none-map <path>] [--results-dir <path>]
 *
 * `--none-map` takes `{ "<eval id>": "known" | "unknown" }` and splits pass
 * rates by it. The split is skipped when the flag or the file is absent.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPERIMENTS = [
  'claude-code-sonnet-5-corpus-full',
  'claude-code-sonnet-5-corpus-none',
  'claude-code-sonnet-5-corpus-gap',
] as const;

/** Experiments that must not reach the web or the docs search tool. */
const RESTRICTED = new Set<string>([
  'claude-code-sonnet-5-corpus-none',
  'claude-code-sonnet-5-corpus-gap',
]);

const VIOLATION_SOURCES = new Set([
  'web_fetch',
  'web_search',
  'shell_fetch',
  'search_docs',
]);

export type RunRecord = {
  experiment: string;
  evalId: string;
  passed: boolean;
  violationSources: string[];
};

export type NoneLabel = 'known' | 'unknown';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function readRuns(resultsDir: string, experiment: string): RunRecord[] {
  const expDir = join(resultsDir, experiment);
  if (!existsSync(expDir)) return [];
  const runs: RunRecord[] = [];
  for (const evalId of readdirSync(expDir)) {
    const evalDir = join(expDir, evalId);
    for (const run of readdirSync(evalDir)) {
      if (!run.startsWith('run-')) continue;
      const file = join(evalDir, run, 'result.json');
      if (!existsSync(file)) continue;
      const result = JSON.parse(readFileSync(file, 'utf8')) as {
        passed?: boolean;
        docs?: { calls?: Array<{ source?: string }> };
      };
      const sources = (result.docs?.calls ?? [])
        .map((call) => call.source ?? '')
        .filter((source) => VIOLATION_SOURCES.has(source));
      runs.push({
        experiment,
        evalId,
        passed: result.passed === true,
        violationSources: [...new Set(sources)],
      });
    }
  }
  return runs;
}

function rate(runs: RunRecord[]): string {
  if (runs.length === 0) return 'n/a';
  const passed = runs.filter((r) => r.passed).length;
  return `${passed}/${runs.length} (${Math.round((passed / runs.length) * 100)}%)`;
}

export function summarize(
  runs: RunRecord[],
  experiment: string,
  noneMap?: Record<string, NoneLabel>
): string[] {
  const mine = runs.filter((r) => r.experiment === experiment);
  const evals = new Set(mine.map((r) => r.evalId));
  const lines = [
    `${experiment}`,
    `  evals run: ${evals.size}`,
    `  runs: ${mine.length}`,
    `  pass rate: ${rate(mine)}`,
  ];
  if (RESTRICTED.has(experiment)) {
    const count = (source: string) =>
      mine.filter((r) => r.violationSources.includes(source)).length;
    const any = mine.filter((r) => r.violationSources.length > 0).length;
    lines.push(
      `  violations (runs with any web or docs call): ${any}`,
      `    web_fetch: ${count('web_fetch')}, web_search: ${count('web_search')}, shell_fetch: ${count('shell_fetch')}, search_docs: ${count('search_docs')}`
    );
  } else {
    lines.push('  violations: n/a (control may use the web and docs)');
  }
  if (noneMap) {
    for (const label of ['known', 'unknown'] as const) {
      const subset = mine.filter((r) => noneMap[r.evalId] === label);
      lines.push(
        `  pass rate, none-map ${label}: ${rate(subset)} over ${new Set(subset.map((r) => r.evalId)).size} evals`
      );
    }
    const unmapped = [...evals].filter((id) => !noneMap[id]).length;
    if (unmapped > 0) lines.push(`  evals missing from none-map: ${unmapped}`);
  }
  return lines;
}

export function perEvalTable(runs: RunRecord[]): string[] {
  const ids = [...new Set(runs.map((r) => r.evalId))].sort();
  const short = ['full', 'none', 'gap'];
  const rows = ids.map((id) => [
    id,
    ...EXPERIMENTS.map((e) =>
      rate(runs.filter((r) => r.experiment === e && r.evalId === id))
    ),
  ]);
  const header = ['eval', ...short];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length))
  );
  const fmt = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  return [fmt(header), fmt(widths.map((w) => '-'.repeat(w))), ...rows.map(fmt)];
}

function readFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main() {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const resultsDir = resolve(
    readFlag(argv, 'results-dir') ?? join(ROOT, 'results')
  );
  const noneMapPath = readFlag(argv, 'none-map');
  let noneMap: Record<string, NoneLabel> | undefined;
  if (noneMapPath) {
    if (existsSync(noneMapPath)) {
      noneMap = JSON.parse(readFileSync(noneMapPath, 'utf8'));
    } else {
      console.warn(`none-map ${noneMapPath} not found; skipping the split`);
    }
  }
  const runs = EXPERIMENTS.flatMap((e) => readRuns(resultsDir, e));
  if (runs.length === 0) {
    console.log(`no corpus results under ${resultsDir}`);
    return;
  }
  for (const experiment of EXPERIMENTS) {
    console.log(summarize(runs, experiment, noneMap).join('\n'));
    console.log('');
  }
  console.log(perEvalTable(runs).join('\n'));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
