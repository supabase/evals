#!/usr/bin/env tsx
/**
 * Upsert the exported `eval-results.json` snapshot into the Supabase eval-results
 * store — the durable, queryable source of truth for the public
 * leaderboard, replacing the committed JSON file.
 *
 * One row per (experiment, eval); re-running upserts on that key so the store
 * always reflects the latest snapshot. Writes use the service-role key (bypasses
 * RLS); the web app reads via the anon key under the "public read" policy.
 *
 * Usage:
 *   pnpm upload:supabase                 # upsert the default snapshot
 *   pnpm upload:supabase -- --dry        # map + print, no network (no keys needed)
 *   pnpm upload:supabase -- --input path/to/results.json
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment
 * (loaded from repo-root .env) unless running with --dry.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
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
const TABLE = "eval_results";
const CHUNK_SIZE = 500;

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1 || index === args.length - 1) {
    return undefined;
  }
  return args[index + 1];
}

const rawArgs = process.argv.slice(2);
const DRY = rawArgs.includes("--dry");
const INPUT_PATH = resolve(ROOT, readFlag(rawArgs, "input") ?? DEFAULT_INPUT);

// A result row as it appears in the web-facing snapshot: the core EvalResult
// plus the display/source fields export-results.ts adds.
type ResultRow = EvalResult & {
  experimentSuite?: string;
  prompt?: string;
  promptSourcePath?: string;
  sourcePath?: string;
};

// One row of the public.eval_results table (snake_case columns).
type EvalResultRow = {
  experiment: string;
  eval: string;
  experiment_suite: string | null;
  agent: string | null;
  model_provider: string | null;
  model_id: string | null;
  reasoning_effort: string | null;
  stage: string | null;
  product: string[] | null;
  topic: string[] | null;
  suite: string | null;
  interface: string | null;
  cli_version: string | null;
  passed: boolean;
  checks: unknown;
  attempts: number | null;
  skills: unknown;
  prompt: string | null;
  prompt_source_path: string | null;
  source_path: string | null;
};

function isResultRow(value: unknown): value is ResultRow {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ResultRow).experiment === "string" &&
    typeof (value as ResultRow).eval === "string"
  );
}

/** Map a snapshot row onto an eval_results table row. */
export function toEvalResultRow(row: ResultRow): EvalResultRow {
  return {
    experiment: row.experiment,
    eval: row.eval,
    experiment_suite: row.experimentSuite ?? null,
    agent: row.experimentDisplay?.agent ?? null,
    model_provider: row.experimentDisplay?.modelProvider ?? null,
    model_id: row.experimentDisplay?.modelId ?? null,
    reasoning_effort: row.experimentDisplay?.reasoningEffort ?? null,
    stage: row.stage ?? null,
    product: row.product ?? null,
    topic: row.topic ?? null,
    suite: row.suite ?? null,
    interface: row.interface ?? null,
    cli_version: row.cliVersion ?? null,
    passed: row.passed === true,
    checks: row.checks ?? null,
    attempts: row.attempts ?? null,
    skills: row.skills ?? null,
    prompt: row.prompt ?? null,
    prompt_source_path: row.promptSourcePath ?? null,
    source_path: row.sourcePath ?? null,
  };
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

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function main(): Promise<void> {
  const rows = (await loadResults(INPUT_PATH)).map(toEvalResultRow);
  if (rows.length === 0) {
    throw new Error(`No usable results found in ${INPUT_PATH}`);
  }

  if (DRY) {
    const passed = rows.filter((row) => row.passed).length;
    console.log(
      `[dry run] would upsert ${rows.length} row(s) into "${TABLE}" ` +
        `(${passed} pass, ${rows.length - passed} fail) from ${INPUT_PATH}`,
    );
    console.log(JSON.stringify(rows[0], null, 2));
    return;
  }

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (or run with --dry).",
    );
  }

  const supabase = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });

  console.log(`Upserting ${rows.length} row(s) into "${TABLE}" at ${url}...`);
  for (const batch of chunk(rows, CHUNK_SIZE)) {
    const { error } = await supabase
      .from(TABLE)
      .upsert(batch, { onConflict: "experiment,eval" });
    if (error) {
      throw new Error(`Upsert failed: ${error.message}`);
    }
  }
  console.log("Done.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
