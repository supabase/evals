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
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { parseEvalMarkdown } from "@supabase-evals/core/eval-markdown";
import { rawEvalResultSchema } from "@supabase-evals/core/eval-metadata";
import { getExperimentDisplayMetadata, type ExperimentConfig, type ExperimentDisplayMetadata } from "@supabase-evals/core";
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
const EXPERIMENTS_DIR = join(ROOT, "experiments");
const OUTPUT_PATH = join(ROOT, "apps", "web", "src", "data", "eval-results.json");

async function loadExperimentDisplay(): Promise<Map<string, ExperimentDisplayMetadata>> {
  const map = new Map<string, ExperimentDisplayMetadata>();
  for (const f of (await readdir(EXPERIMENTS_DIR)).filter((f) => f.endsWith(".ts"))) {
    const mod = await import(pathToFileURL(join(EXPERIMENTS_DIR, f)).href);
    map.set(f.replace(/\.ts$/, ""), getExperimentDisplayMetadata(mod.default as ExperimentConfig));
  }
  return map;
}
const rawArgs = process.argv.slice(2);
const EXPERIMENT_FILTERS = readRepeatedFlag(rawArgs, "experiment").map(
  normalizeExperimentName,
);
const EVAL_FILTERS = readRepeatedFlag(rawArgs, "eval");
const SUITE_FILTERS = readSuiteFilters(rawArgs);
const MERGE = rawArgs.includes("--merge");

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
  experimentDisplay: Map<string, ExperimentDisplayMetadata>,
): Promise<EvalResult | null> {
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  const result = rawEvalResultSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  const parsedResult = result.data;
  const display = experimentDisplay.get(parsedResult.experiment);

  const promptData = await readPrompt(parsedResult.eval);

  return {
    experiment: parsedResult.experiment,
    experimentDisplay: parsedResult.experimentDisplay ?? display,
    eval: parsedResult.eval,
    stage: promptData?.stage ?? parsedResult.stage,
    product: promptData?.product ?? parsedResult.product,
    topic: promptData?.topic ?? parsedResult.topic,
    suite: promptData?.suite ?? parsedResult.suite,
    interface: promptData?.interface ?? parsedResult.interface,
    passed: parsedResult.passed === true,
    checks: parsedResult.checks,
    skills: parsedResult.skills,
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

  const experimentDisplay = await loadExperimentDisplay();
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

        const result = await readResultFile(entryPath, relativeEntryPath, experimentDisplay);
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
        experimentDisplay,
      );
      if (result && shouldIncludeSuite(result.suite)) {
        results.push(result);
      }
    }
  }

  return results.sort(
    (a, b) =>
      a.experiment.localeCompare(b.experiment) || a.eval.localeCompare(b.eval),
  );
}

async function main() {
  const newResults = await loadEvalResults();
  const hasFilters =
    EXPERIMENT_FILTERS.length > 0 ||
    EVAL_FILTERS.length > 0 ||
    SUITE_FILTERS.length > 0;

  if (hasFilters && newResults.length === 0) {
    throw new Error("no result files matched the requested export filters");
  }

  let results = newResults;
  if (MERGE && existsSync(OUTPUT_PATH)) {
    const existing: EvalResult[] = JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
    const replaced = new Set(newResults.map((r) => `${r.experiment}::${r.eval}`));
    results = [
      ...existing.filter((r) => !replaced.has(`${r.experiment}::${r.eval}`)),
      ...newResults,
    ].sort(
      (a, b) =>
        a.experiment.localeCompare(b.experiment) || a.eval.localeCompare(b.eval),
    );
  }

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(results, null, 2)}\n`);

  const passed = results.filter((result) => result.passed).length;
  console.log(
    `Exported ${results.length} result(s) to ${relative(ROOT, OUTPUT_PATH)} ` +
      `(${passed} pass, ${results.length - passed} fail)`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
