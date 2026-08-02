#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { rawEvalResultSchema } from '@supabase-evals/core/eval-metadata';
import type {
  EvalResult,
  EvalSuite,
  ExperimentSuite,
} from '@supabase-evals/core/eval-metadata';
import {
  makeFilterPredicate,
  normalizeExperimentName,
  readExperimentSuiteFilters,
  readRepeatedFlag,
  readSuiteFilters,
} from '../lib/cli-args.js';
import {
  ROOT,
  collectResultFiles,
  loadExperimentMetadata,
  readPrompt,
  type ExperimentExportMetadata,
} from '../lib/result-files.js';

const OUTPUT_PATH = join(
  ROOT,
  'apps',
  'web',
  'src',
  'data',
  'eval-results.json'
);

const rawArgs = process.argv.slice(2);
const EXPERIMENT_FILTERS = readRepeatedFlag(rawArgs, 'experiment').map(
  normalizeExperimentName
);
const EVAL_FILTERS = readRepeatedFlag(rawArgs, 'eval');
const SUITE_FILTERS = readSuiteFilters(rawArgs);
const EXPERIMENT_SUITE_FILTERS = readExperimentSuiteFilters(rawArgs);
const MERGE = rawArgs.includes('--merge');

const OUTPUT_FLAG = readRepeatedFlag(rawArgs, 'output')[0];
const outputPath = OUTPUT_FLAG ? resolve(ROOT, OUTPUT_FLAG) : OUTPUT_PATH;

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

const shouldIncludeSuite = makeFilterPredicate<EvalSuite>(SUITE_FILTERS);
const shouldIncludeExperimentSuite = makeFilterPredicate<ExperimentSuite>(
  EXPERIMENT_SUITE_FILTERS
);

async function loadEvalResults(): Promise<EvalResult[]> {
  const experimentMetadata = await loadExperimentMetadata();
  const refs = await collectResultFiles({
    includeExperiment: shouldIncludeExperiment,
    includeEval: shouldIncludeEval,
  });

  const results: EvalResult[] = [];
  for (const ref of refs) {
    const result = await readResultFile(
      ref.filePath,
      ref.sourcePath,
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

  return results.sort(
    (a, b) =>
      a.experiment.localeCompare(b.experiment) || a.eval.localeCompare(b.eval)
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

  let results = newResults;
  if (MERGE && existsSync(outputPath)) {
    const existing: EvalResult[] = JSON.parse(
      await readFile(outputPath, 'utf8')
    );
    const replaced = new Set(
      newResults.map((r) => `${r.experiment}::${r.eval}`)
    );
    results = [
      ...existing.filter((r) => !replaced.has(`${r.experiment}::${r.eval}`)),
      ...newResults,
    ].sort(
      (a, b) =>
        a.experiment.localeCompare(b.experiment) || a.eval.localeCompare(b.eval)
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
