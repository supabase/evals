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
  EVAL_PRODUCTS,
  EVAL_STAGES,
  parseEvalMarkdown,
} from "@supabase-evals/core/eval-metadata";
import type {
  CheckResult,
  EvalProduct,
  EvalResult,
  EvalStage,
} from "@supabase-evals/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");
const RESULTS_DIR = join(ROOT, "results");
const EVALS_DIR = join(ROOT, "evals");
const OUTPUT_PATH = join(ROOT, "apps", "web", "src", "data", "eval-results.json");
const rawArgs = process.argv.slice(2);
const EXPERIMENT_FILTERS = readRepeatedFlag("experiment").map(
  normalizeExperimentName,
);
const EVAL_FILTERS = readRepeatedFlag("eval");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const EVAL_STAGE_VALUES: readonly string[] = EVAL_STAGES;
const EVAL_PRODUCT_VALUES: readonly string[] = EVAL_PRODUCTS;

function isEvalStage(value: string): value is EvalStage {
  return EVAL_STAGE_VALUES.includes(value);
}

function isEvalProduct(value: string): value is EvalProduct {
  return EVAL_PRODUCT_VALUES.includes(value);
}

function readStage(value: unknown): EvalStage | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return isEvalStage(value) ? value : undefined;
}

function readProductArray(value: unknown): EvalProduct[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const products = value.filter(
    (item): item is EvalProduct => typeof item === "string" && isEvalProduct(item),
  );
  return products.length > 0 ? products : undefined;
}

function readTopicArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const topics = value.filter((item): item is string => typeof item === "string");
  return topics.length > 0 ? topics : undefined;
}

function readChecks(value: unknown): CheckResult[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const checks = value.flatMap((item) => {
    const check = readCheck(item);
    return check ? [check] : [];
  });

  return checks.length > 0 ? checks : undefined;
}

function readCheck(value: unknown): CheckResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = value.name;
  const passed = value.passed;
  const notes = value.notes;
  const judgeNotes = value.judgeNotes;

  if (typeof name !== "string" || typeof passed !== "boolean") {
    return undefined;
  }

  return {
    name,
    passed,
    notes: typeof notes === "string" ? notes : undefined,
    judgeNotes: typeof judgeNotes === "string" ? judgeNotes : undefined,
  };
}

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

  if (!isRecord(parsed)) {
    return null;
  }

  const experiment = parsed.experiment;
  const evalId = parsed.eval;

  if (typeof experiment !== "string" || typeof evalId !== "string") {
    return null;
  }

  const promptData = await readPrompt(evalId);

  return {
    experiment,
    eval: evalId,
    stage: promptData?.stage ?? readStage(parsed.stage),
    product: promptData?.product ?? readProductArray(parsed.product),
    topic: promptData?.topic ?? readTopicArray(parsed.topic),
    passed: parsed.passed === true,
    checks: readChecks(parsed.checks),
    prompt: promptData?.prompt,
    promptSourcePath: promptData?.promptSourcePath,
    attempts: typeof parsed.attempts === "number" ? parsed.attempts : undefined,
    sourcePath,
  };
}

function readRepeatedFlag(name: string): string[] {
  const values: string[] = [];
  const prefix = `--${name}=`;

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg) continue;

    if (arg.startsWith(prefix)) {
      values.push(...splitList(arg.slice(prefix.length)));
      continue;
    }

    if (arg === `--${name}`) {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`--${name} requires a value`);
      }
      values.push(...splitList(value));
      index += 1;
    }
  }

  return values;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeExperimentName(value: string): string {
  return value.replace(/^experiments\//, "").replace(/\.ts$/, "");
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
        if (result) {
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
      if (result) {
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
  const results = await loadEvalResults();
  const hasFilters = EXPERIMENT_FILTERS.length > 0 || EVAL_FILTERS.length > 0;

  if (hasFilters && results.length === 0) {
    throw new Error("no result files matched the requested export filters");
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
