#!/usr/bin/env tsx
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { parseEvalMarkdown } from '@supabase-evals/core/eval-markdown';
import { rawEvalResultSchema } from '@supabase-evals/core/eval-metadata';
import {
  getExperimentDisplayMetadata,
  type ExperimentConfig,
  type ExperimentDisplayMetadata,
} from '@supabase-evals/core';
import type {
  EvalResult,
  EvalSuite,
  ExperimentSuite,
} from '@supabase-evals/core/eval-metadata';
import {
  normalizeExperimentName,
  positiveInteger,
  readExperimentSuiteFilters,
  readFlag,
  readRepeatedFlag,
  readSuiteFilters,
} from '../lib/cli-args.js';
import {
  formatIncompleteSampleSets,
  splitBySampleSetCompleteness,
} from '../lib/sample-sets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
const RESULTS_DIR = join(ROOT, 'results');
const EVALS_DIR = join(ROOT, 'evals');
const EXPERIMENTS_DIR = join(ROOT, 'experiments');
const OUTPUT_PATH = join(
  ROOT,
  'apps',
  'web',
  'src',
  'data',
  'eval-results.json'
);

type ExperimentExportMetadata = {
  display: ExperimentDisplayMetadata;
  experimentSuite?: ExperimentSuite;
};

async function loadExperimentMetadata(): Promise<
  Map<string, ExperimentExportMetadata>
> {
  const map = new Map<string, ExperimentExportMetadata>();
  for (const f of (await readdir(EXPERIMENTS_DIR)).filter((f) =>
    f.endsWith('.ts')
  )) {
    const mod = await import(pathToFileURL(join(EXPERIMENTS_DIR, f)).href);
    const config = mod.default as ExperimentConfig;
    map.set(f.replace(/\.ts$/, ''), {
      display: getExperimentDisplayMetadata(config),
      experimentSuite: config.suite?.[0],
    });
  }
  return map;
}
const rawArgs = process.argv.slice(2);
const EXPERIMENT_FILTERS = readRepeatedFlag(rawArgs, 'experiment').map(
  normalizeExperimentName
);
const EVAL_FILTERS = readRepeatedFlag(rawArgs, 'eval');
const SUITE_FILTERS = readSuiteFilters(rawArgs);
const EXPERIMENT_SUITE_FILTERS = readExperimentSuiteFilters(rawArgs);
const MERGE = rawArgs.includes('--merge');
// Opt-in completeness guard. Off by default so ad-hoc single-run exports still
// work; pass the same `--runs` the harness ran with to skip partial pairs.
const EXPECTED_RUNS_FLAG = readFlag(rawArgs, 'runs');

const OUTPUT_FLAG = readRepeatedFlag(rawArgs, 'output')[0];
const outputPath = OUTPUT_FLAG ? resolve(ROOT, OUTPUT_FLAG) : OUTPUT_PATH;

async function readPrompt(evalId: string) {
  const promptPath = resolve(EVALS_DIR, evalId, 'PROMPT.md');
  const normalizedEvalsDir = resolve(EVALS_DIR);

  if (!promptPath.startsWith(`${normalizedEvalsDir}${sep}`)) {
    return undefined;
  }

  if (!existsSync(promptPath)) {
    return undefined;
  }

  const parsed = parseEvalMarkdown(
    await readFile(promptPath, 'utf8'),
    promptPath
  );

  return {
    ...parsed.metadata,
    prompt: parsed.body,
    promptSourcePath: relative(ROOT, promptPath).split(sep).join('/'),
  };
}

async function readResultFile(
  filePath: string,
  sourcePath: string,
  experimentMetadata: Map<string, ExperimentExportMetadata>
): Promise<EvalResult | null> {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  const result = rawEvalResultSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  const parsedResult = result.data;
  const experimentData = experimentMetadata.get(parsedResult.experiment);

  const promptData = await readPrompt(parsedResult.eval);
  const experimentSuite =
    parsedResult.experimentSuite ??
    parsedResult.profile ??
    experimentData?.experimentSuite;

  return {
    experiment: parsedResult.experiment,
    experimentSuite,
    experimentDisplay:
      parsedResult.experimentDisplay ?? experimentData?.display,
    eval: parsedResult.eval,
    stage: promptData?.stage ?? parsedResult.stage,
    product: promptData?.product ?? parsedResult.product,
    topic: promptData?.topic ?? parsedResult.topic,
    suite: promptData?.suite ?? parsedResult.suite,
    interface: promptData?.interface ?? parsedResult.interface,
    cliVersion: promptData?.cliVersion ?? parsedResult.cliVersion,
    passed: parsedResult.passed === true,
    checks: parsedResult.checks,
    skills: parsedResult.skills,
    docs: parsedResult.docs,
    prompt: promptData?.prompt,
    promptSourcePath: promptData?.promptSourcePath,
    attempts: parsedResult.attempts,
    run: parsedResult.run,
    sourcePath,
  };
}

function shouldIncludeExperiment(experiment: string): boolean {
  if (EXPERIMENT_FILTERS.length === 0) {
    return true;
  }

  return EXPERIMENT_FILTERS.includes(normalizeExperimentName(experiment));
}

function shouldIncludeEval(evalId: string): boolean {
  if (EVAL_FILTERS.length === 0) {
    return true;
  }

  return EVAL_FILTERS.includes(evalId);
}

function shouldIncludeSuite(suite: EvalSuite | undefined): boolean {
  if (SUITE_FILTERS.length === 0) {
    return true;
  }

  return suite !== undefined && SUITE_FILTERS.includes(suite);
}

function shouldIncludeExperimentSuite(
  experimentSuite: ExperimentSuite | undefined
): boolean {
  if (EXPERIMENT_SUITE_FILTERS.length === 0) {
    return true;
  }

  return (
    experimentSuite !== undefined &&
    EXPERIMENT_SUITE_FILTERS.includes(experimentSuite)
  );
}

async function loadEvalResults(): Promise<EvalResult[]> {
  if (!existsSync(RESULTS_DIR)) {
    return [];
  }

  const experimentMetadata = await loadExperimentMetadata();
  const results: EvalResult[] = [];
  const experiments = await readdir(RESULTS_DIR);

  for (const experiment of experiments) {
    if (experiment.startsWith('.') || experiment.startsWith('_')) {
      continue;
    }

    if (!shouldIncludeExperiment(experiment)) {
      continue;
    }

    const experimentDir = join(RESULTS_DIR, experiment);
    if (!(await stat(experimentDir)).isDirectory()) {
      continue;
    }

    // Canonical raw layout: results/<experiment>/<eval>/run-<n>/result.json.
    // One exported row per scored run.
    for (const entry of await readdir(experimentDir)) {
      const evalDir = join(experimentDir, entry);
      if (!(await stat(evalDir)).isDirectory()) {
        continue;
      }

      if (!shouldIncludeEval(entry)) {
        continue;
      }

      for (const runEntry of (await readdir(evalDir)).sort()) {
        if (!/^run-\d+$/.test(runEntry)) {
          continue;
        }

        const resultFile = join(evalDir, runEntry, 'result.json');
        if (!existsSync(resultFile)) {
          continue;
        }

        const result = await readResultFile(
          resultFile,
          relative(RESULTS_DIR, resultFile).split(sep).join('/'),
          experimentMetadata
        );
        if (
          result &&
          shouldIncludeSuite(result.suite) &&
          shouldIncludeExperimentSuite(result.experimentSuite)
        ) {
          results.push(result);
        }
      }
    }
  }

  return results.sort(
    (a, b) =>
      a.experiment.localeCompare(b.experiment) ||
      a.eval.localeCompare(b.eval) ||
      (a.run ?? 0) - (b.run ?? 0)
  );
}

async function main() {
  const newResults = await loadEvalResults();
  const hasFilters =
    EXPERIMENT_FILTERS.length > 0 ||
    EVAL_FILTERS.length > 0 ||
    SUITE_FILTERS.length > 0 ||
    EXPERIMENT_SUITE_FILTERS.length > 0;

  if (hasFilters && newResults.length === 0) {
    throw new Error('no result files matched the requested export filters');
  }

  let exportable = newResults;
  if (EXPECTED_RUNS_FLAG !== undefined) {
    const expectedRuns = positiveInteger(EXPECTED_RUNS_FLAG, 'runs');
    const split = splitBySampleSetCompleteness(newResults, expectedRuns);
    if (split.incomplete.length > 0) {
      // A dropped pair keeps whatever rows it already had in the output, so a
      // partial refresh never overwrites a good sample set with a worse one.
      console.warn(formatIncompleteSampleSets(split.incomplete, expectedRuns));
    }
    if (split.complete.length === 0) {
      throw new Error(
        'every matched pair had an incomplete sample set; nothing to export'
      );
    }
    exportable = split.complete;
  }

  let results = exportable;
  if (MERGE && existsSync(outputPath)) {
    const existing: EvalResult[] = JSON.parse(
      await readFile(outputPath, 'utf8')
    );
    const replaced = new Set(
      exportable.map((r) => `${r.experiment}::${r.eval}`)
    );
    results = [
      ...existing.filter((r) => !replaced.has(`${r.experiment}::${r.eval}`)),
      ...exportable,
    ].sort(
      (a, b) =>
        a.experiment.localeCompare(b.experiment) ||
        a.eval.localeCompare(b.eval) ||
        (a.run ?? 0) - (b.run ?? 0)
    );
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`);

  const passed = results.filter((result) => result.passed).length;
  console.log(
    `Exported ${results.length} result(s) to ${relative(ROOT, outputPath)} ` +
      `(${passed} pass, ${results.length - passed} fail)`
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
