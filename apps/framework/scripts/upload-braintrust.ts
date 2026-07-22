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
 *   --summary-md <p>  write a markdown summary (links + passed Δ vs main),
 *                     used by CI to post/update a PR comment
 *   --set-baseline    mark these experiments as the latest-main baseline
 *                     (passed by CI only for full refreshes on main)
 */

import { readFile, writeFile } from "node:fs/promises";
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
  makeFilterPredicate,
  normalizeExperimentName,
  readExperimentSuiteFilters,
  readRepeatedFlag,
  readSuiteFilters,
} from "../lib/cli-args.js";
import {
  ROOT,
  collectResultFiles,
  loadExperimentMetadata,
  rawTranscriptPathFor,
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
const SUMMARY_MD = readRepeatedFlag(rawArgs, "summary-md")[0];
const SET_BASELINE = rawArgs.includes("--set-baseline");

const shouldIncludeSuite = makeFilterPredicate<EvalSuite>(SUITE_FILTERS);
const shouldIncludeExperimentSuite = makeFilterPredicate<ExperimentSuite>(
  EXPERIMENT_SUITE_FILTERS,
);

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

/**
 * Which branch (and PR, if any) produced this upload, stored as experiment
 * metadata. `branch` gates whether --set-baseline may stamp `latestMain`
 * (the marker PR runs compare against); `prNumber` powers the "results for
 * this PR" filter link.
 */
interface RunContext {
  branch?: string;
  prNumber?: string;
}

function runContext(): RunContext {
  if (!process.env.GITHUB_EVENT_NAME) {
    try {
      return {
        branch: execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: ROOT,
          encoding: "utf8",
        }).trim(),
      };
    } catch {
      return {};
    }
  }
  // For PR events GITHUB_REF_NAME is "<number>/merge".
  const prMatch = /^(\d+)\/merge$/.exec(process.env.GITHUB_REF_NAME ?? "");
  return {
    branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME,
    ...(process.env.GITHUB_EVENT_NAME === "pull_request" && prMatch
      ? { prNumber: prMatch[1] }
      : {}),
  };
}

/**
 * Experiments-list URL pre-filtered by BTQL expressions, mirroring the UI's
 * own format: `?search={"filter":["<expr>"]}` with the expression
 * URL-encoded inside the JSON and the JSON encoded again.
 */
function experimentsFilterUrl(
  anyExperimentUrl: string,
  expr: string,
): string | undefined {
  const marker = "/experiments/";
  const index = anyExperimentUrl.lastIndexOf(marker);
  if (index === -1) return undefined;
  const base = anyExperimentUrl.slice(0, index + marker.length - 1);
  const search = encodeURIComponent(
    JSON.stringify({ filter: [encodeURIComponent(expr)] }),
  );
  return `${base}?search=${search}`;
}

/**
 * The experiments marked `latestMain` for this repo experiment. `baseline`
 * (the newest holder's name) is the source-of-truth base every run compares
 * against;
 * `holderIds` is every current holder, saved BEFORE uploading so a main
 * refresh can demote them all only after the new batch is fully uploaded —
 * if the upload dies, the old baselines keep the marker. Clearing every
 * holder (not just the newest) also self-heals duplicates left by a past
 * failed demotion. The repo experiment name already encodes agent + model +
 * skills, so metadata equality is an exact identity match. Best-effort: any
 * failure means "no base", never a broken upload.
 */
async function findMainBaseline(
  projectId: string | undefined,
  experiment: string,
  currentName: string,
): Promise<{ baseline?: string; holderIds: string[] }> {
  const apiKey = process.env.BRAINTRUST_API_KEY;
  if (!projectId || !apiKey) return { holderIds: [] };
  try {
    const metadata = encodeURIComponent(
      JSON.stringify({ experiment, latestMain: true }),
    );
    const response = await fetch(
      `https://api.braintrust.dev/v1/experiment?project_id=${encodeURIComponent(projectId)}&metadata=${metadata}&limit=100`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!response.ok) return { holderIds: [] };
    const body = (await response.json()) as {
      objects?: Array<{ id?: string; name?: string; created?: string }>;
    };
    const holders = (body.objects ?? [])
      .filter(
        (o): o is { id: string; name: string; created?: string } =>
          typeof o.id === "string" &&
          typeof o.name === "string" &&
          o.name !== currentName,
      )
      .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
    return {
      ...(holders[0] ? { baseline: holders[0].name } : {}),
      holderIds: holders.map((holder) => holder.id),
    };
  } catch {
    return { holderIds: [] };
  }
}

/**
 * Set or clear an experiment's `latestMain` marker (best-effort). PATCH
 * merges metadata, and a null value no longer matches `latestMain = true`
 * filters (verified against the API). Promotion happens only after a
 * successful upload+summarize, so a crashed main refresh can never win the
 * baseline tie-break; a failed demotion leaves extra holders, which
 * findMainBaseline resolves to the newest (and clears on the next refresh).
 */
async function setLatestMain(
  experimentId: string,
  value: true | null,
): Promise<void> {
  const apiKey = process.env.BRAINTRUST_API_KEY;
  if (!apiKey) return;
  try {
    const response = await fetch(
      `https://api.braintrust.dev/v1/experiment/${experimentId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ metadata: { latestMain: value } }),
      },
    );
    if (!response.ok) {
      console.warn(`latestMain update failed (${response.status}) for ${experimentId}`);
    }
  } catch (error) {
    console.warn(`latestMain update failed for ${experimentId}: ${String(error)}`);
  }
}

interface SummaryRow {
  /** Repo experiment name (identity: agent + model + skills). */
  experiment: string;
  url?: string;
  evalCount: number;
  passedCount: number;
  passedDiff?: number;
  baseName?: string;
  /** PR experiment page pre-compared against the main baseline (`?c=`). */
  compareUrl?: string;
}

function formatSummaryMarkdown(
  rows: SummaryRow[],
  filterLinks: Array<{ label: string; url: string }>,
): string {
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const lines = [
    "<!-- braintrust-eval-results -->",
    "### Braintrust benchmark results",
    "",
    "| Experiment | passed | Δ vs main |",
    "|---|---|---|",
  ];
  for (const row of rows) {
    const name = row.url ? `[${row.experiment}](${row.url})` : row.experiment;
    const passed = `${row.passedCount}/${row.evalCount} · ${pct(row.passedCount / Math.max(row.evalCount, 1))}`;
    let diff = "– (no main baseline)";
    if (row.baseName) {
      const sha = row.baseName.split("@")[1];
      const base = sha ? `main@${sha}` : row.baseName;
      let label = `– vs ${base}`;
      if (row.passedDiff !== undefined) {
        const points = Math.round(row.passedDiff * 100);
        const glyph = points > 0 ? "🟢 +" : points < 0 ? "🔴 " : "⚪ ";
        label = `${glyph}${points}% vs ${base}`;
      }
      diff = row.compareUrl ? `[${label}](${row.compareUrl})` : label;
    }
    lines.push(`| ${name} | ${passed} | ${diff} |`);
  }
  if (filterLinks.length > 0) {
    lines.push(
      "",
      filterLinks.map(({ label, url }) => `[${label}](${url})`).join(" · "),
    );
  }
  return `${lines.join("\n")}\n`;
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
    const transcriptPath = rawTranscriptPathFor(ref.filePath);
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
  const context = runContext();
  const summaryRows: SummaryRow[] = [];

  // Becoming the baseline is opt-in (--set-baseline, passed by CI only for
  // full refreshes on main) with belt-and-braces local guards.
  const isMainRefresh =
    SET_BASELINE &&
    context.branch === "main" &&
    !context.prNumber &&
    !NAME_SUFFIX;

  // Old baseline holders across the whole batch, demoted only after every
  // experiment uploaded (see findMainBaseline).
  const supersededHolderIds: string[] = [];

  for (const [experiment, pending] of byExperiment) {
    const name = `${experiment}${sha ? `@${sha}` : ""}${suffix}`;
    const meta = experimentMetadata.get(experiment);
    const { baseline, holderIds } = await findMainBaseline(
      projectId,
      experiment,
      name,
    );
    const btExperiment = init({
      ...(projectName ? { project: projectName } : {}),
      ...(projectId ? { projectId } : {}),
      experiment: name,
      update: UPDATE,
      ...(baseline ? { baseExperiment: baseline } : {}),
      metadata: {
        source: "supabase-evals",
        experiment,
        ...(meta?.experimentSuite
          ? { experimentSuite: meta.experimentSuite }
          : {}),
        ...(meta?.display ?? {}),
        ...(sha ? { gitShortSha: sha } : {}),
        ...(runUrl ? { ciRunUrl: runUrl } : {}),
        ...(context.branch ? { branch: context.branch } : {}),
        ...(context.prNumber ? { prNumber: context.prNumber } : {}),
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

    const summary = await btExperiment.summarize();
    if (isMainRefresh && summary.experimentId) {
      await setLatestMain(summary.experimentId, true);
      supersededHolderIds.push(
        ...holderIds.filter((id) => id !== summary.experimentId),
      );
    }
    // Only trust the diff when it is against the baseline we selected — with
    // none set, Braintrust auto-picks a base by git ancestry, which could be
    // another PR's experiment.
    const baseName =
      baseline && summary.comparisonExperimentName === baseline
        ? baseline
        : undefined;
    summaryRows.push({
      experiment,
      url: summary.experimentUrl,
      evalCount: pending.length,
      passedCount: pending.filter(({ trace }) => trace.scores.passed === 1)
        .length,
      ...(baseName ? { passedDiff: summary.scores?.passed?.diff } : {}),
      baseName,
      // `?c=` opens the experiment pre-compared against the baseline
      // (observed from the Braintrust UI's own comparison URLs; not a
      // documented param — worst case the link opens uncompared).
      ...(summary.experimentUrl && baseName
        ? {
            compareUrl: `${summary.experimentUrl}?c=${encodeURIComponent(baseName)}`,
          }
        : {}),
    });
    console.log(
      `Uploaded ${pending.length} eval trace(s) to Braintrust experiment "${name}"` +
        (summary.experimentUrl ? `\n   → ${summary.experimentUrl}` : ""),
    );
  }

  await flush();

  // The whole batch is uploaded and marked — only now retire the old
  // baselines. A crash before this point leaves them in place (and any
  // temporary duplicate holders resolve newest-first in findMainBaseline).
  for (const id of supersededHolderIds) {
    await setLatestMain(id, null);
  }

  // Pre-filtered experiments-list links (Braintrust bakes view filters into
  // the URL): this PR's experiments, and the main-branch baseline history.
  const anyUrl = summaryRows.find((row) => row.url)?.url;
  const filterLinks: Array<{ label: string; url: string }> = [];
  if (anyUrl) {
    const add = (label: string, expr: string) => {
      const url = experimentsFilterUrl(anyUrl, expr);
      if (url) filterLinks.push({ label, url });
    };
    if (context.prNumber) {
      add(
        `Braintrust results for PR #${context.prNumber}`,
        `metadata.prNumber = '${context.prNumber}'`,
      );
    }
    add("Latest main results", `metadata.latestMain = true`);
    for (const { label, url } of filterLinks) {
      console.log(`${label}: ${url}`);
    }
  }

  if (SUMMARY_MD) {
    await writeFile(SUMMARY_MD, formatSummaryMarkdown(summaryRows, filterLinks));
    console.log(`Wrote summary to ${SUMMARY_MD}`);
  }
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
