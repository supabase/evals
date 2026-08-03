#!/usr/bin/env tsx
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { parseEvalMarkdown } from '@supabase-evals/core/eval-markdown';
import { rawEvalResultSchema } from '@supabase-evals/core/eval-metadata';
import {
  evalResultToTraceSpans,
  getExperimentDisplayMetadata,
  type EvalResultTraceInput,
  type ExperimentConfig,
  type ExperimentDisplayMetadata,
} from '@supabase-evals/core';
import type {
  EvalResult,
  EvalSuite,
  ExperimentSuite,
} from '@supabase-evals/core/eval-metadata';
import type { ToolCallRecord, TranscriptPart } from '@supabase-evals/core';
import {
  normalizeExperimentName,
  readExperimentSuiteFilters,
  readRepeatedFlag,
  readSuiteFilters,
} from '../lib/cli-args.js';

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
const TRACES_DIR = join(ROOT, 'apps', 'web', 'src', 'data', 'traces');

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
// Per-eval trace JSON for the web viewer's TracePanel. On by default; flip with
// `--no-traces`. Written lazily (one file per evalId) so the aggregate bundle
// stays lean — the web app fetches a trace only when a row is selected.
const WRITE_TRACES = !rawArgs.includes('--no-traces');

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
): Promise<{ result: EvalResult; traceInput: EvalResultTraceInput } | null> {
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

  const evalResult: EvalResult = {
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

  // rawEvalResultSchema is loose, so the transcript/toolCalls/agentReport the
  // strict evalResultSchema drops are still here — that's what the trace
  // adapter consumes.
  const traceInput: EvalResultTraceInput = {
    evalId: parsedResult.eval,
    passed: parsedResult.passed === true,
    transcript: parsedResult.transcript as TranscriptPart[] | undefined,
    toolCalls: parsedResult.toolCalls as ToolCallRecord[] | undefined,
    agentReport: parsedResult.agentReport as string | undefined,
    skills: parsedResult.skills,
    checks: parsedResult.checks,
    experimentDisplay: parsedResult.experimentDisplay,
    attempts: parsedResult.attempts,
  };

  return { result: evalResult, traceInput };
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

async function loadEvalResults(): Promise<{
  results: EvalResult[];
  traceInputs: Map<string, EvalResultTraceInput>;
}> {
  const traceInputs = new Map<string, EvalResultTraceInput>();
  if (!existsSync(RESULTS_DIR)) {
    return { results: [], traceInputs };
  }

  const experimentMetadata = await loadExperimentMetadata();
  const results: EvalResult[] = [];
  const experiments = await readdir(RESULTS_DIR);

  // Same evalId may run under several experiments (different agents/models).
  // Prefer a run that actually recorded a transcript over one that didn't, so
  // the trace viewer shows a real span tree rather than an empty no-skills run.
  const upsertTrace = (input: EvalResultTraceInput) => {
    const existing = traceInputs.get(input.evalId);
    const hasTranscript = (input.transcript?.length ?? 0) > 0;
    if (!existing || (hasTranscript && !existing.transcript?.length)) {
      traceInputs.set(input.evalId, input);
    }
  };

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

    for (const entry of await readdir(experimentDir)) {
      const entryPath = join(experimentDir, entry);
      const entryStat = await stat(entryPath);
      const relativeEntryPath = relative(RESULTS_DIR, entryPath)
        .split(sep)
        .join('/');

      if (entryStat.isFile() && entry.endsWith('.json')) {
        const evalId = entry.replace(/\.json$/, '');
        if (!shouldIncludeEval(evalId)) {
          continue;
        }

        const read = await readResultFile(
          entryPath,
          relativeEntryPath,
          experimentMetadata
        );
        if (
          read &&
          shouldIncludeSuite(read.result.suite) &&
          shouldIncludeExperimentSuite(read.result.experimentSuite)
        ) {
          results.push(read.result);
          upsertTrace(read.traceInput);
        }
        continue;
      }

      if (!entryStat.isDirectory()) {
        continue;
      }

      if (!shouldIncludeEval(entry)) {
        continue;
      }

      const summaryPath = join(entryPath, 'summary.json');
      if (!existsSync(summaryPath)) {
        continue;
      }

      const read = await readResultFile(
        summaryPath,
        `${relativeEntryPath}/summary.json`,
        experimentMetadata
      );
      if (
        read &&
        shouldIncludeSuite(read.result.suite) &&
        shouldIncludeExperimentSuite(read.result.experimentSuite)
      ) {
        results.push(read.result);
        upsertTrace(read.traceInput);
      }
    }
  }

  results.sort(
    (a, b) =>
      a.experiment.localeCompare(b.experiment) || a.eval.localeCompare(b.eval)
  );
  return { results, traceInputs };
}

async function writeTraces(
  traceInputs: Map<string, EvalResultTraceInput>
): Promise<number> {
  if (!WRITE_TRACES) return 0;
  await mkdir(TRACES_DIR, { recursive: true });
  let written = 0;
  for (const [evalId, input] of traceInputs) {
    const data = evalResultToTraceSpans(input);
    await writeFile(
      join(TRACES_DIR, `${evalId}.json`),
      `${JSON.stringify(data, null, 2)}\n`
    );
    written += 1;
  }
  return written;
}

async function main() {
  const { results: newResults, traceInputs } = await loadEvalResults();
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

  const tracesWritten = await writeTraces(traceInputs);
  if (WRITE_TRACES) {
    console.log(
      `Exported ${tracesWritten} trace(s) to ${relative(ROOT, TRACES_DIR)}`
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
