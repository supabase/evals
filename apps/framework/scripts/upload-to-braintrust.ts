#!/usr/bin/env tsx
/**
 * Upload the exported `eval-results.json` snapshot to Braintrust.
 *
 * This is the first, deliberately small step of AI-921: store eval results in
 * Braintrust instead of (or alongside) the committed JSON file. It does NOT run
 * evals — it reads the same snapshot the web app consumes and mirrors it into
 * Braintrust experiments so we can try their built-in comparison/leaderboard UI.
 *
 * Mapping (one Braintrust **experiment** per result-file `experiment` /
 * Configuration name, one **event** per eval):
 *   - id        ← eval id (stable, so `--update` re-logs the same row)
 *   - input     ← { eval, prompt }
 *   - output    ← { passed, checks }
 *   - scores    ← { passed: 0|1, checkPassRate: 0..1 } (comparable across evals)
 *   - metadata  ← everything else, with experimentDisplay flattened to top-level
 *                 keys (agent, modelProvider, modelId, reasoningEffort) so they
 *                 can be used directly as Braintrust grouping axes
 *   - tags      ← product + topic + interface + experimentSuite (for filtering)
 *
 * Usage:
 *   pnpm upload:braintrust                 # upload default snapshot
 *   pnpm upload:braintrust -- --dry        # map + print, no network (no key needed)
 *   pnpm upload:braintrust -- --update     # append to existing named experiments
 *   pnpm upload:braintrust -- --project my-project --input path/to/results.json
 *
 * Requires BRAINTRUST_API_KEY in the environment (loaded from repo-root .env)
 * unless running with --dry.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "braintrust";
import type { EvalResult } from "@supabase-evals/core/eval-metadata";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");
const DEFAULT_INPUT = resolve(
  ROOT,
  "apps",
  "web",
  "src",
  "data",
  "eval-results.json",
);
const DEFAULT_PROJECT = process.env.BRAINTRUST_PROJECT ?? "supabase-evals";

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1 || index === args.length - 1) {
    return undefined;
  }
  return args[index + 1];
}

const rawArgs = process.argv.slice(2);
const DRY = rawArgs.includes("--dry");
const UPDATE = rawArgs.includes("--update");
const INPUT_PATH = resolve(ROOT, readFlag(rawArgs, "input") ?? DEFAULT_INPUT);
const PROJECT = readFlag(rawArgs, "project") ?? DEFAULT_PROJECT;

// A result row as it appears in the web-facing snapshot: the core EvalResult
// plus the display/source fields export-results.ts adds.
type ResultRow = EvalResult & {
  experimentSuite?: string;
  prompt?: string;
  promptSourcePath?: string;
  sourcePath?: string;
};

function isResultRow(value: unknown): value is ResultRow {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ResultRow).experiment === "string" &&
    typeof (value as ResultRow).eval === "string"
  );
}

async function loadResults(path: string): Promise<ResultRow[]> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected an array of results in ${path}`);
  }
  const rows = parsed.filter(isResultRow);
  const skipped = parsed.length - rows.length;
  if (skipped > 0) {
    console.warn(
      `Skipped ${skipped} malformed record(s) (missing experiment/eval).`,
    );
  }
  return rows;
}

function groupByExperiment(rows: ResultRow[]): Map<string, ResultRow[]> {
  const groups = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const existing = groups.get(row.experiment);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(row.experiment, [row]);
    }
  }
  return groups;
}

function scoresFor(row: ResultRow): Record<string, number> {
  const passed = row.passed === true ? 1 : 0;
  const checks = row.checks ?? [];
  const checkPassRate = checks.length
    ? checks.filter((check) => check.passed).length / checks.length
    : passed;
  return { passed, checkPassRate };
}

function metadataFor(row: ResultRow): Record<string, unknown> {
  return {
    eval: row.eval,
    experiment: row.experiment,
    experimentSuite: row.experimentSuite,
    stage: row.stage,
    product: row.product,
    topic: row.topic,
    suite: row.suite,
    interface: row.interface,
    cliVersion: row.cliVersion,
    attempts: row.attempts,
    // Flatten experimentDisplay so each dimension is a first-class grouping axis.
    agent: row.experimentDisplay?.agent,
    modelProvider: row.experimentDisplay?.modelProvider,
    modelId: row.experimentDisplay?.modelId,
    reasoningEffort: row.experimentDisplay?.reasoningEffort,
    skillsAvailable: row.skills?.available,
    skillsLoaded: row.skills?.loaded,
    promptSourcePath: row.promptSourcePath,
    sourcePath: row.sourcePath,
  };
}

function tagsFor(row: ResultRow): string[] {
  const candidates: Array<string | undefined> = [
    row.interface,
    row.experimentSuite,
    ...(row.product ?? []),
    ...(row.topic ?? []),
  ];
  const tags = candidates.filter(
    (tag): tag is string => typeof tag === "string" && tag.length > 0,
  );
  return [...new Set(tags)];
}

// Experiment-level metadata, derived from the first row of the group. These are
// constant per Configuration, so they belong on the experiment, not each event.
function experimentMetadata(row: ResultRow): Record<string, unknown> {
  return {
    experimentSuite: row.experimentSuite,
    agent: row.experimentDisplay?.agent,
    modelProvider: row.experimentDisplay?.modelProvider,
    modelId: row.experimentDisplay?.modelId,
    reasoningEffort: row.experimentDisplay?.reasoningEffort,
    source: "eval-results.json",
  };
}

async function uploadExperiment(name: string, rows: ResultRow[]): Promise<void> {
  const experiment = init(PROJECT, {
    experiment: name,
    update: UPDATE,
    metadata: experimentMetadata(rows[0]),
  });

  for (const row of rows) {
    experiment.log({
      id: row.eval,
      input: { eval: row.eval, prompt: row.prompt },
      output: { passed: row.passed === true, checks: row.checks ?? [] },
      scores: scoresFor(row),
      metadata: metadataFor(row),
      tags: tagsFor(row),
    });
  }

  await experiment.flush();

  const passed = rows.filter((row) => row.passed === true).length;
  const summary = await experiment.summarize({ summarizeScores: false });
  console.log(
    `  ${name}: logged ${rows.length} result(s) (${passed} pass, ${rows.length - passed} fail) → ${summary.experimentUrl}`,
  );
}

function printDryRun(groups: Map<string, ResultRow[]>): void {
  console.log(
    `[dry run] would upload to Braintrust project "${PROJECT}"` +
      (UPDATE ? " (update mode)" : "") +
      ` from ${INPUT_PATH}`,
  );
  for (const [name, rows] of groups) {
    const passed = rows.filter((row) => row.passed === true).length;
    console.log(
      `  experiment "${name}": ${rows.length} event(s) (${passed} pass, ${rows.length - passed} fail)`,
    );
  }
}

async function main(): Promise<void> {
  const rows = await loadResults(INPUT_PATH);
  if (rows.length === 0) {
    throw new Error(`No usable results found in ${INPUT_PATH}`);
  }
  const groups = groupByExperiment(rows);

  if (DRY) {
    printDryRun(groups);
    return;
  }

  if (!process.env.BRAINTRUST_API_KEY) {
    throw new Error(
      "BRAINTRUST_API_KEY is not set. Add it to your .env (or run with --dry).",
    );
  }

  console.log(
    `Uploading ${rows.length} result(s) across ${groups.size} experiment(s) to Braintrust project "${PROJECT}"...`,
  );
  for (const [name, experimentRows] of groups) {
    await uploadExperiment(name, experimentRows);
  }
  console.log("Done.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
