/**
 * Pure mapping from the exported `eval-results.json` shape onto the fields
 * Braintrust's `experiment.log()` expects. Kept free of any I/O or SDK calls so
 * it can be unit-tested without credentials or network (see the sibling test).
 */
import type { EvalResult } from "@supabase-evals/core/eval-metadata";

// A result row as it appears in the web-facing snapshot: the core EvalResult
// plus the display/source fields export-results.ts adds.
export type ResultRow = EvalResult & {
  experimentSuite?: string;
  prompt?: string;
  promptSourcePath?: string;
  sourcePath?: string;
};

export function isResultRow(value: unknown): value is ResultRow {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ResultRow).experiment === "string" &&
    typeof (value as ResultRow).eval === "string"
  );
}

export function groupByExperiment(rows: ResultRow[]): Map<string, ResultRow[]> {
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

/**
 * Numeric, cross-eval-comparable scores. `passed` mirrors the run's pass@k
 * outcome; `checkPassRate` is the fraction of individual checks that passed,
 * falling back to `passed` when a run has no per-check breakdown.
 */
export function scoresFor(row: ResultRow): Record<string, number> {
  const passed = row.passed === true ? 1 : 0;
  const checks = row.checks ?? [];
  const checkPassRate = checks.length
    ? checks.filter((check) => check.passed).length / checks.length
    : passed;
  return { passed, checkPassRate };
}

export function metadataFor(row: ResultRow): Record<string, unknown> {
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

export function tagsFor(row: ResultRow): string[] {
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

/**
 * Experiment-level metadata, derived from the first row of the group. These are
 * constant per Configuration, so they belong on the experiment, not each event.
 */
export function experimentMetadata(row: ResultRow): Record<string, unknown> {
  return {
    experimentSuite: row.experimentSuite,
    agent: row.experimentDisplay?.agent,
    modelProvider: row.experimentDisplay?.modelProvider,
    modelId: row.experimentDisplay?.modelId,
    reasoningEffort: row.experimentDisplay?.reasoningEffort,
    source: "eval-results.json",
  };
}
