/**
 * Shared access to the raw result files under `results/` — the scan, the
 * per-experiment metadata from `experiments/*.ts`, and the PROMPT.md lookup —
 * used by both `scripts/export-results.ts` (eval-results.json) and
 * `scripts/upload-braintrust.ts` (Braintrust experiments), so the two
 * pipelines can never disagree about which files exist.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEvalMarkdown } from "@supabase-evals/core/eval-markdown";
import {
  getExperimentDisplayMetadata,
  type ExperimentConfig,
  type ExperimentDisplayMetadata,
} from "@supabase-evals/core";
import type {
  EvalMetadata,
  ExperimentSuite,
} from "@supabase-evals/core/eval-metadata";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..", "..", "..");
export const RESULTS_DIR = join(ROOT, "results");
export const EVALS_DIR = join(ROOT, "evals");
export const EXPERIMENTS_DIR = join(ROOT, "experiments");

export type ExperimentExportMetadata = {
  display: ExperimentDisplayMetadata;
  experimentSuite?: ExperimentSuite;
};

export async function loadExperimentMetadata(): Promise<
  Map<string, ExperimentExportMetadata>
> {
  const map = new Map<string, ExperimentExportMetadata>();
  for (const f of (await readdir(EXPERIMENTS_DIR)).filter((f) =>
    f.endsWith(".ts"),
  )) {
    const mod = await import(pathToFileURL(join(EXPERIMENTS_DIR, f)).href);
    const config = mod.default as ExperimentConfig;
    map.set(f.replace(/\.ts$/, ""), {
      display: getExperimentDisplayMetadata(config),
      experimentSuite: config.suite?.[0],
    });
  }
  return map;
}

export type PromptData = EvalMetadata & {
  prompt: string;
  promptSourcePath: string;
};

export async function readPrompt(
  evalId: string,
): Promise<PromptData | undefined> {
  const promptPath = resolve(EVALS_DIR, evalId, "PROMPT.md");
  const normalizedEvalsDir = resolve(EVALS_DIR);

  if (!promptPath.startsWith(`${normalizedEvalsDir}${sep}`)) {
    return undefined;
  }

  if (!existsSync(promptPath)) {
    return undefined;
  }

  const parsed = parseEvalMarkdown(
    await readFile(promptPath, "utf8"),
    promptPath,
  );

  return {
    ...parsed.metadata,
    prompt: parsed.body,
    promptSourcePath: relative(ROOT, promptPath).split(sep).join("/"),
  };
}

export interface ResultFileRef {
  experiment: string;
  evalId: string;
  /** Absolute path to the JSON file. */
  filePath: string;
  /** Path relative to `results/`, POSIX separators. */
  sourcePath: string;
}

/**
 * Every raw result file under `results/`, honoring the layout the runner
 * writes: `results/<experiment>/<evalId>.json`, or
 * `results/<experiment>/<evalId>/summary.json` for directory-shaped results.
 */
export async function collectResultFiles(filter: {
  includeExperiment: (experiment: string) => boolean;
  includeEval: (evalId: string) => boolean;
}): Promise<ResultFileRef[]> {
  if (!existsSync(RESULTS_DIR)) {
    return [];
  }

  const refs: ResultFileRef[] = [];
  for (const experiment of await readdir(RESULTS_DIR)) {
    if (experiment.startsWith(".") || experiment.startsWith("_")) {
      continue;
    }

    if (!filter.includeExperiment(experiment)) {
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
        .join("/");

      if (entryStat.isFile() && entry.endsWith(".json")) {
        const evalId = entry.replace(/\.json$/, "");
        if (!filter.includeEval(evalId)) {
          continue;
        }
        refs.push({
          experiment,
          evalId,
          filePath: entryPath,
          sourcePath: relativeEntryPath,
        });
        continue;
      }

      if (!entryStat.isDirectory()) {
        continue;
      }

      if (!filter.includeEval(entry)) {
        continue;
      }

      const summaryPath = join(entryPath, "summary.json");
      if (!existsSync(summaryPath)) {
        continue;
      }

      refs.push({
        experiment,
        evalId: entry,
        filePath: summaryPath,
        sourcePath: `${relativeEntryPath}/summary.json`,
      });
    }
  }

  return refs;
}
