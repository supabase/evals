#!/usr/bin/env tsx
/**
 * Uploads raw eval results to Braintrust as one experiment per repo
 * experiment (model) and one trace per eval: root "eval" row (scores +
 * metadata + metrics) with llm/tool/task/score child spans rebuilt from the
 * persisted transcript (see `buildEvalTrace` in @supabase-evals/core).
 *
 * A second, additive destination: it only reads `results/` and never touches
 * eval-results.json — the dual-write agreed in Slack while Braintrust is
 * evaluated as the storage layer. Missing credentials are a warning, not an
 * error, so this can run unconditionally in CI without gating the export.
 *
 * Env: BRAINTRUST_API_KEY + BRAINTRUST_PROJECT_ID (or BRAINTRUST_PROJECT for
 * a project name, or --project).
 *
 * Flags mirror export-results (--experiment/--eval/--suite/--experiment-suite)
 * plus:
 *   --dry             build and print the traces, no network
 *   --project <name>  Braintrust project name (overrides env)
 *   --name-suffix <s> extra suffix on the Braintrust experiment names
 *   --update          append to existing same-named Braintrust experiments
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildEvalTrace,
  uploadableEvalResultSchema,
  type BraintrustEvalTrace,
} from "@supabase-evals/core";
import type {
  EvalSuite,
  ExperimentSuite,
} from "@supabase-evals/core/eval-metadata";
import {
  normalizeExperimentName,
  readExperimentSuiteFilters,
  readRepeatedFlag,
  readSuiteFilters,
} from "../lib/cli-args.js";
import {
  ROOT,
  collectResultFiles,
  loadExperimentMetadata,
  readPrompt,
  type PromptData,
} from "../lib/result-files.js";

const rawArgs = process.argv.slice(2);
const EXPERIMENT_FILTERS = readRepeatedFlag(rawArgs, "experiment").map(
  normalizeExperimentName,
);
const EVAL_FILTERS = readRepeatedFlag(rawArgs, "eval");
const SUITE_FILTERS = readSuiteFilters(rawArgs);
const EXPERIMENT_SUITE_FILTERS = readExperimentSuiteFilters(rawArgs);
const DRY = rawArgs.includes("--dry");
const UPDATE = rawArgs.includes("--update");
const PROJECT_FLAG = readRepeatedFlag(rawArgs, "project")[0];
const NAME_SUFFIX = readRepeatedFlag(rawArgs, "name-suffix")[0];

function shouldIncludeSuite(suite: EvalSuite | undefined): boolean {
  if (SUITE_FILTERS.length === 0) return true;
  return suite !== undefined && SUITE_FILTERS.includes(suite);
}

function shouldIncludeExperimentSuite(
  experimentSuite: ExperimentSuite | undefined,
): boolean {
  if (EXPERIMENT_SUITE_FILTERS.length === 0) return true;
  return (
    experimentSuite !== undefined &&
    EXPERIMENT_SUITE_FILTERS.includes(experimentSuite)
  );
}

function gitShortSha(): string | undefined {
  const fromEnv = process.env.GITHUB_SHA;
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

function ciRunUrl(): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) {
    return undefined;
  }
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

interface PendingTrace {
  trace: BraintrustEvalTrace;
  /** Raw result file, attached to the root span for full-fidelity forensics. */
  filePath: string;
  /**
   * The agent CLI's verbatim JSONL transcript (sibling
   * `<evalId>.transcript.jsonl` written by the runner), attached alongside.
   */
  rawTranscriptPath?: string;
}

async function collectTraces(
  experimentMetadata: Awaited<ReturnType<typeof loadExperimentMetadata>>,
): Promise<Map<string, PendingTrace[]>> {
  const refs = await collectResultFiles({
    includeExperiment: (experiment) =>
      EXPERIMENT_FILTERS.length === 0 ||
      EXPERIMENT_FILTERS.includes(normalizeExperimentName(experiment)),
    includeEval: (evalId) =>
      EVAL_FILTERS.length === 0 || EVAL_FILTERS.includes(evalId),
  });

  const promptCache = new Map<string, PromptData | undefined>();
  const readPromptCached = async (evalId: string) => {
    if (!promptCache.has(evalId)) {
      promptCache.set(evalId, await readPrompt(evalId));
    }
    return promptCache.get(evalId);
  };

  const byExperiment = new Map<string, PendingTrace[]>();
  let skipped = 0;

  for (const ref of refs) {
    let json: unknown;
    try {
      json = JSON.parse(await readFile(ref.filePath, "utf8"));
    } catch {
      skipped += 1;
      console.warn(`SKIP ${ref.sourcePath}: not valid JSON`);
      continue;
    }
    const parsed = uploadableEvalResultSchema.safeParse(json);
    if (!parsed.success) {
      skipped += 1;
      console.warn(`SKIP ${ref.sourcePath}: does not match the result schema`);
      continue;
    }
    const result = parsed.data;
    const promptData = await readPromptCached(result.eval);
    const experimentSuite =
      result.experimentSuite ??
      result.profile ??
      experimentMetadata.get(result.experiment)?.experimentSuite;
    const suite = promptData?.suite ?? result.suite;
    if (!shouldIncludeSuite(suite) || !shouldIncludeExperimentSuite(experimentSuite)) {
      continue;
    }

    // Fill dimensions from PROMPT.md like the JSON export does, so both
    // destinations describe a scenario identically.
    const trace = buildEvalTrace({
      experiment: result.experiment,
      result: {
        ...result,
        experimentSuite,
        experimentDisplay:
          result.experimentDisplay ??
          experimentMetadata.get(result.experiment)?.display,
        stage: promptData?.stage ?? result.stage,
        product: promptData?.product ?? result.product,
        topic: promptData?.topic ?? result.topic,
        suite,
        interface: promptData?.interface ?? result.interface,
        cliVersion: promptData?.cliVersion ?? result.cliVersion,
      },
      prompt: promptData?.prompt,
      extraMetadata: {
        sourcePath: ref.sourcePath,
        ...(promptData?.promptSourcePath
          ? { promptSourcePath: promptData.promptSourcePath }
          : {}),
      },
      baseTimeMs: Date.now(),
    });
    const transcriptPath = ref.filePath.replace(/\.json$/, ".transcript.jsonl");
    const group = byExperiment.get(result.experiment) ?? [];
    group.push({
      trace,
      filePath: ref.filePath,
      ...(existsSync(transcriptPath) ? { rawTranscriptPath: transcriptPath } : {}),
    });
    byExperiment.set(result.experiment, group);
  }

  if (skipped > 0) {
    console.warn(`Skipped ${skipped} unparseable result file(s).`);
  }
  return byExperiment;
}

function printDry(byExperiment: Map<string, PendingTrace[]>): void {
  for (const [experiment, pending] of byExperiment) {
    console.log(`\n${experiment}: ${pending.length} eval trace(s)`);
    for (const { trace } of pending) {
      const spanSummary = trace.spans
        .map((s) => `${s.type}:${s.name}`)
        .join(", ");
      console.log(
        `  ${trace.evalId} — scores=${JSON.stringify(trace.scores)} spans=[${spanSummary}]`,
      );
    }
  }
  const first = byExperiment.values().next().value?.[0];
  if (first) {
    console.log("\nFirst trace, full shape:");
    console.log(JSON.stringify(first.trace, null, 2));
  }
}

async function upload(
  byExperiment: Map<string, PendingTrace[]>,
  experimentMetadata: Awaited<ReturnType<typeof loadExperimentMetadata>>,
) {
  // Imported lazily so --dry works without braintrust needing credentials.
  const { init, Attachment, flush } = await import("braintrust");

  const projectName = PROJECT_FLAG ?? process.env.BRAINTRUST_PROJECT;
  const projectId = process.env.BRAINTRUST_PROJECT_ID;
  const sha = gitShortSha();
  const suffix = NAME_SUFFIX ? `-${NAME_SUFFIX}` : "";
  const runUrl = ciRunUrl();

  for (const [experiment, pending] of byExperiment) {
    const name = `${experiment}${sha ? `@${sha}` : ""}${suffix}`;
    const meta = experimentMetadata.get(experiment);
    const btExperiment = init({
      ...(projectName ? { project: projectName } : {}),
      ...(projectId ? { projectId } : {}),
      experiment: name,
      update: UPDATE,
      metadata: {
        source: "supabase-evals",
        experiment,
        ...(meta?.experimentSuite
          ? { experimentSuite: meta.experimentSuite }
          : {}),
        ...(meta?.display ?? {}),
        ...(sha ? { gitShortSha: sha } : {}),
        ...(runUrl ? { ciRunUrl: runUrl } : {}),
      },
    });

    for (const { trace, filePath, rawTranscriptPath } of pending) {
      const root = btExperiment.startSpan({
        name: trace.evalId,
        type: "eval",
        startTime: trace.startMs / 1000,
      });
      root.log({
        input: trace.input,
        ...(trace.output !== undefined ? { output: trace.output } : {}),
        scores: trace.scores,
        metadata: {
          ...trace.metadata,
          rawResultFile: new Attachment({
            data: filePath,
            filename: `${trace.experiment}__${trace.evalId}.json`,
            contentType: "application/json",
          }),
          // The agent CLI's own transcript, verbatim — attachments are
          // Braintrust's mechanism for large documents (span fields cap out;
          // attachments go to object storage and stay downloadable).
          ...(rawTranscriptPath
            ? {
                rawTranscript: new Attachment({
                  data: rawTranscriptPath,
                  filename: basename(rawTranscriptPath),
                  contentType: "application/jsonl",
                }),
              }
            : {}),
        },
        ...(Object.keys(trace.metrics).length > 0
          ? { metrics: trace.metrics }
          : {}),
        ...(trace.tags.length > 0 ? { tags: trace.tags } : {}),
      });
      const logSpanTree = (
        parent: typeof root,
        span: (typeof trace.spans)[number],
      ): void => {
        const child = parent.startSpan({
          name: span.name,
          type: span.type,
          startTime: span.startMs / 1000,
        });
        child.log({
          ...(span.input !== undefined ? { input: span.input } : {}),
          ...(span.output !== undefined ? { output: span.output } : {}),
          ...(span.error !== undefined ? { error: span.error } : {}),
          ...(span.metadata ? { metadata: span.metadata } : {}),
          ...(span.metrics ? { metrics: span.metrics } : {}),
          ...(span.scores ? { scores: span.scores } : {}),
        });
        for (const grandchild of span.children ?? []) {
          logSpanTree(child, grandchild);
        }
        child.end({ endTime: span.endMs / 1000 });
      };
      for (const span of trace.spans) {
        logSpanTree(root, span);
      }
      root.end({ endTime: trace.endMs / 1000 });
    }

    const summary = await btExperiment.summarize({ summarizeScores: false });
    console.log(
      `Uploaded ${pending.length} eval trace(s) to Braintrust experiment "${name}"` +
        (summary.experimentUrl ? `\n   → ${summary.experimentUrl}` : ""),
    );
  }

  await flush();
}

async function main() {
  const experimentMetadata = await loadExperimentMetadata();
  const byExperiment = await collectTraces(experimentMetadata);
  const total = [...byExperiment.values()].reduce((n, t) => n + t.length, 0);
  if (total === 0) {
    console.log("No result files matched — nothing to upload.");
    return;
  }

  if (DRY) {
    printDry(byExperiment);
    return;
  }

  const hasProject =
    PROJECT_FLAG || process.env.BRAINTRUST_PROJECT || process.env.BRAINTRUST_PROJECT_ID;
  if (!process.env.BRAINTRUST_API_KEY || !hasProject) {
    console.warn(
      "Braintrust upload skipped: set BRAINTRUST_API_KEY and " +
        "BRAINTRUST_PROJECT_ID (or BRAINTRUST_PROJECT / --project).",
    );
    return;
  }

  await upload(byExperiment, experimentMetadata);
  console.log(`Done: ${total} eval trace(s) across ${byExperiment.size} experiment(s).`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
