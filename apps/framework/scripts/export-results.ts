#!/usr/bin/env tsx
import {
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evalResultSchema,
  parseEvalMarkdown,
  rawEvalResultSchema,
} from "@supabase-evals/core/eval-metadata";
import type {
  EvalResult,
  EvalSuite,
} from "@supabase-evals/core/eval-metadata";
import {
  normalizeExperimentName,
  readRepeatedFlag,
  readSuiteFilters,
} from "../lib/cli-args.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");
const RESULTS_DIR = join(ROOT, "results");
const EVALS_DIR = join(ROOT, "evals");
const OUTPUT_PATH = join(ROOT, "apps", "web", "src", "data", "eval-results.json");
const rawArgs = process.argv.slice(2);
const EXPERIMENT_FILTERS = readRepeatedFlag(rawArgs, "experiment").map(
  normalizeExperimentName,
);
const EVAL_FILTERS = readRepeatedFlag(rawArgs, "eval");
const SUITE_FILTERS = readSuiteFilters(rawArgs);
const MERGE_RESULTS = rawArgs.includes("--merge");

type ExistingEvalResult = {
  parsed: EvalResult;
  original: unknown;
};

type MergedEvalResult = {
  parsed: EvalResult;
  output: unknown;
};

async function readPrompt(evalId: string) {
  const promptPath = resolve(EVALS_DIR, evalId, "PROMPT.md");
  const normalizedEvalsDir = resolve(EVALS_DIR);

  if (!promptPath.startsWith(`${normalizedEvalsDir}${sep}`)) {
    return undefined;
  }

  if (!existsSync(promptPath)) {
    return undefined;
  }

  const parsed = parseEvalMarkdown(await readFile(promptPath, "utf8"), promptPath);

  return {
    ...parsed.metadata,
    prompt: parsed.body,
    promptSourcePath: relative(ROOT, promptPath).split(sep).join("/"),
  };
}

async function readResultFile(
  filePath: string,
  sourcePath: string,
): Promise<EvalResult | null> {
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  const result = rawEvalResultSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  const parsedResult = result.data;

  const promptData = await readPrompt(parsedResult.eval);

  return {
    experiment: parsedResult.experiment,
    eval: parsedResult.eval,
    stage: promptData?.stage ?? parsedResult.stage,
    product: promptData?.product ?? parsedResult.product,
    topic: promptData?.topic ?? parsedResult.topic,
    suite: promptData?.suite ?? parsedResult.suite,
    passed: parsedResult.passed === true,
    checks: parsedResult.checks,
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

function shouldIncludeSuite(suite: EvalSuite | undefined): boolean {
  if (SUITE_FILTERS.length === 0) {
    return true;
  }

  return suite !== undefined && SUITE_FILTERS.includes(suite);
}

async function loadEvalResults(): Promise<EvalResult[]> {
  if (!existsSync(RESULTS_DIR)) {
    return [];
  }

  const results: EvalResult[] = [];
  const experiments = await readdir(RESULTS_DIR);

  for (const experiment of experiments) {
    if (experiment.startsWith(".") || experiment.startsWith("_")) {
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
      const relativeEntryPath = relative(RESULTS_DIR, entryPath).split(sep).join("/");

      if (entryStat.isFile() && entry.endsWith(".json")) {
        const evalId = entry.replace(/\.json$/, "");
        if (!shouldIncludeEval(evalId)) {
          continue;
        }

        const result = await readResultFile(entryPath, relativeEntryPath);
        if (result && shouldIncludeSuite(result.suite)) {
          results.push(result);
        }
        continue;
      }

      if (!entryStat.isDirectory()) {
        continue;
      }

      if (!shouldIncludeEval(entry)) {
        continue;
      }

      const summaryPath = join(entryPath, "summary.json");
      if (!existsSync(summaryPath)) {
        continue;
      }

      const result = await readResultFile(
        summaryPath,
        `${relativeEntryPath}/summary.json`,
      );
      if (result && shouldIncludeSuite(result.suite)) {
        results.push(result);
      }
    }
  }

  return sortResults(results);
}

function resultKey(result: Pick<EvalResult, "experiment" | "eval">): string {
  return `${normalizeExperimentName(result.experiment)}\0${result.eval}`;
}

function sortResults(results: EvalResult[]): EvalResult[] {
  return results.sort(
    (a, b) =>
      a.experiment.localeCompare(b.experiment) || a.eval.localeCompare(b.eval),
  );
}

async function loadExistingExportedResults(): Promise<ExistingEvalResult[]> {
  if (!existsSync(OUTPUT_PATH)) {
    return [];
  }

  const existingResults: unknown = JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
  if (!Array.isArray(existingResults)) {
    throw new Error(
      `could not parse existing exported results at ${relative(ROOT, OUTPUT_PATH)}`,
    );
  }

  const results = evalResultSchema.array().safeParse(existingResults);
  if (!results.success) {
    throw new Error(
      `could not parse existing exported results at ${relative(ROOT, OUTPUT_PATH)}`,
    );
  }

  return results.data.map((result, index) => ({
    parsed: result,
    original: existingResults[index],
  }));
}

async function mergeEvalResults(results: EvalResult[]): Promise<MergedEvalResult[]> {
  const merged = new Map<string, MergedEvalResult>();

  for (const result of await loadExistingExportedResults()) {
    merged.set(resultKey(result.parsed), {
      parsed: result.parsed,
      output: result.original,
    });
  }

  for (const result of results) {
    merged.set(resultKey(result), {
      parsed: result,
      output: result,
    });
  }

  return [...merged.values()]
    .sort(
      (a, b) =>
        a.parsed.experiment.localeCompare(b.parsed.experiment) ||
        a.parsed.eval.localeCompare(b.parsed.eval),
    );
}

async function main() {
  const results = await loadEvalResults();
  const hasFilters =
    EXPERIMENT_FILTERS.length > 0 ||
    EVAL_FILTERS.length > 0 ||
    SUITE_FILTERS.length > 0;

  if (hasFilters && results.length === 0) {
    throw new Error("no result files matched the requested export filters");
  }

  const mergedResults = MERGE_RESULTS ? await mergeEvalResults(results) : undefined;
  const exportedResults = mergedResults
    ? mergedResults.map((result) => result.output)
    : results;

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(exportedResults, null, 2)}\n`);

  const passed = mergedResults
    ? mergedResults.filter((result) => result.parsed.passed).length
    : results.filter((result) => result.passed).length;
  const action = MERGE_RESULTS ? "Merged" : "Exported";
  const totalSuffix = MERGE_RESULTS ? `, ${exportedResults.length} total` : "";
  console.log(
    `${action} ${results.length} result(s) to ${relative(ROOT, OUTPUT_PATH)} ` +
      `(${passed} pass, ${exportedResults.length - passed} fail${totalSuffix})`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
