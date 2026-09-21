#!/usr/bin/env tsx
/**
 * Uploads scored runs from `results/` to Braintrust as experiments.
 *
 * One experiment per model per refresh, one row per run. Runs of the same eval
 * share an `input` (the scenario prompt), which is how Braintrust buckets them
 * as trials. Each row carries the agent's messages and tool calls as child
 * spans so a run can be read step by step rather than downloaded as a blob.
 *
 * A second destination, not a replacement: `eval-results.json` is untouched.
 */
import { execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { AgentUsage } from '@supabase-evals/core/eval-metadata';
import {
  normalizeExperimentName,
  readRepeatedFlag,
  readSuiteFilters,
} from '../lib/cli-args.js';
import {
  collectResultFiles,
  loadExperimentMetadata,
  readPrompt,
  ROOT,
  type ExperimentMetadata,
  type PromptData,
} from '../lib/result-files.js';
// Type-only, so `braintrust` stays a lazy import below.
import type { Span } from 'braintrust';

const rawArgs = process.argv.slice(2);
const EXPERIMENT_FILTERS = readRepeatedFlag(rawArgs, 'experiment').map(
  normalizeExperimentName
);
const EVAL_FILTERS = readRepeatedFlag(rawArgs, 'eval');
const SUITE_FILTERS = readSuiteFilters(rawArgs);
const DRY = rawArgs.includes('--dry');

/** Transcript entries as the harness persists them (core's `TranscriptPart`). */
const transcriptPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
  }),
  z.object({
    type: z.literal('tool_call'),
    name: z.string(),
    input: z.record(z.string(), z.unknown()).default({}),
    output: z.unknown().optional(),
    error: z.string().optional(),
  }),
]);
const transcriptSchema = z.array(transcriptPartSchema).catch([]);
type TranscriptPart = z.infer<typeof transcriptPartSchema>;

interface PendingRow {
  evalId: string;
  prompt: string;
  agentReport: string;
  passed: boolean;
  checks: unknown;
  modelId?: string;
  transcript: TranscriptPart[];
  /** Normalized arg per tool call, in transcript order, for span labels. */
  toolLabels: (string | undefined)[];
  metadata: Record<string, unknown>;
  tags: string[];
  metrics: Record<string, number>;
  /** Unix seconds. Absent when the run recorded no duration. */
  startTime?: number;
  endTime?: number;
}

function git(...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      // `describe --exact-match` fails on most commits; its stderr would
      // otherwise read like an upload error.
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Braintrust's first-class git metadata, which it prefers over custom fields so
 * commit and branch stay filterable:
 * https://braintrust.dev/docs/kb/running-evaluations-per-git-commit-sha
 */
function repoInfo() {
  const commit = git('rev-parse', 'HEAD');
  if (!commit) {
    return undefined;
  }
  return {
    commit,
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    tag: git('describe', '--tags', '--exact-match') ?? null,
    dirty: (git('status', '--porcelain') ?? '') !== '',
    author_name: git('log', '-1', '--format=%an'),
    author_email: git('log', '-1', '--format=%ae'),
    commit_message: git('log', '-1', '--format=%s'),
    commit_time: git('log', '-1', '--format=%cI'),
  };
}

/**
 * `prompt_tokens` counts every input token including cache reads and writes,
 * per Braintrust's convention: 10 cache reads + 5 writes + 3 uncached => 18.
 * https://www.braintrust.dev/docs/instrument/advanced-tracing
 */
export function tokenMetrics(
  usage: AgentUsage | undefined
): Record<string, number> {
  if (!usage?.length) {
    return {};
  }
  let prompt = 0;
  let cached = 0;
  let cacheCreate = 0;
  let completion = 0;
  for (const u of usage) {
    const read = u.cacheReadInputTokens ?? 0;
    const write = u.cacheWriteInputTokens ?? 0;
    prompt += (u.inputTokens ?? 0) + read + write;
    cached += read;
    cacheCreate += write;
    completion += u.outputTokens ?? 0;
  }
  const metrics: Record<string, number> = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    tokens: prompt + completion,
  };
  if (cached) {
    metrics.prompt_cached_tokens = cached;
  }
  if (cacheCreate) {
    metrics.prompt_cache_creation_tokens = cacheCreate;
  }
  return metrics;
}

/**
 * The most identifying argument per tool call, in transcript order, so a span
 * reads `Bash: find /tmp/…` rather than a bare `Bash`. The parsers normalize
 * these onto every `ToolCallRecord`; calls without one keep just their name.
 */
function toolLabels(toolCalls: unknown): (string | undefined)[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls.map((call) => {
    const { path, command, url } = z
      .object({
        path: z.string().optional(),
        command: z.string().optional(),
        url: z.string().optional(),
      })
      .catch({})
      .parse(call);
    if (path) {
      return basename(path);
    }
    return command ? summarize(command) : url;
  });
}

/** A command flattened onto one line, short enough to read as a span name. */
function summarize(command: string): string {
  const line = command.trim().replace(/\s+/g, ' ');
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** Links a row back to the PR that triggered the run, on PR runs only. */
function prUrl(): Record<string, string> {
  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = process.env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//)?.[1];
  return repo && prNumber
    ? { pr_url: `https://github.com/${repo}/pull/${prNumber}` }
    : {};
}

/**
 * Builds one row per run, grouped into the experiment it belongs to.
 *
 * Suite filtering happens here rather than during the scan because an eval's
 * suite is read from its PROMPT.md, which isn't loaded until this point.
 */
async function collectRows(
  experimentMetadata: Map<string, ExperimentMetadata>
): Promise<Map<string, PendingRow[]>> {
  const files = await collectResultFiles({
    includeExperiment: (experiment) =>
      EXPERIMENT_FILTERS.length === 0 ||
      EXPERIMENT_FILTERS.includes(normalizeExperimentName(experiment)),
    includeEval: (evalId) =>
      EVAL_FILTERS.length === 0 || EVAL_FILTERS.includes(evalId),
    onUnparseable: (sourcePath, message) =>
      console.warn(`⚠️  skipping ${sourcePath}: ${message}`),
  });

  const promptCache = new Map<string, PromptData>();
  const byExperiment = new Map<string, PendingRow[]>();

  for (const { result, sourcePath, absolutePath } of files) {
    if (!promptCache.has(result.eval)) {
      promptCache.set(result.eval, await readPrompt(result.eval));
    }
    const promptData = promptCache.get(result.eval);
    const suite = promptData?.suite ?? result.suite;
    if (SUITE_FILTERS.length && (!suite || !SUITE_FILTERS.includes(suite))) {
      continue;
    }

    const meta = experimentMetadata.get(result.experiment);
    const display = result.experimentDisplay ?? meta?.display;
    const durationMs =
      result.agentRunDurationMs ??
      (typeof result.durationMs === 'number' ? result.durationMs : undefined);
    // The harness records how long a run took but not when it started, so the
    // span is anchored on the result file's mtime and worked backwards.
    const endTime = durationMs
      ? (await stat(absolutePath)).mtimeMs / 1000
      : undefined;

    const row: PendingRow = {
      evalId: result.eval,
      prompt: promptData?.prompt ?? '',
      agentReport:
        typeof result.agentReport === 'string' ? result.agentReport : '',
      passed: result.passed === true,
      checks: result.checks,
      modelId: display?.modelId,
      transcript: transcriptSchema.parse(result.transcript),
      toolLabels: toolLabels(result.toolCalls),
      metadata: {
        eval: result.eval,
        run: result.run ?? 1,
        // Decomposed so each is independently filterable in the UI.
        agent: display?.agent,
        model_provider: display?.modelProvider,
        model_id: display?.modelId,
        reasoning_effort: display?.reasoningEffort,
        experiment_suites: meta?.suites,
        eval_suite: suite,
        stage: promptData?.stage ?? result.stage,
        interface: promptData?.interface ?? result.interface,
        skills: result.skills,
        docs: result.docs,
        source_path: sourcePath,
      },
      tags: [
        ...(promptData?.product ?? result.product ?? []),
        ...(promptData?.topic ?? result.topic ?? []),
      ].map(String),
      metrics: {
        ...tokenMetrics(result.usage),
        // Braintrust derives an "LLM calls" column from the llm-typed spans,
        // which counts assistant messages rather than model calls. These are
        // the harness's own counts.
        ...(typeof result.stepCount === 'number'
          ? { step_count: result.stepCount }
          : {}),
        ...(typeof result.toolCallCount === 'number'
          ? { tool_call_count: result.toolCallCount }
          : {}),
      },
      ...(endTime && durationMs
        ? { startTime: endTime - durationMs / 1000, endTime }
        : {}),
    };

    const rows = byExperiment.get(result.experiment) ?? [];
    rows.push(row);
    byExperiment.set(result.experiment, rows);
  }
  return byExperiment;
}

/**
 * One child span per transcript entry, in order. Assistant messages are typed
 * `llm` and named after the model so the tree reads like Braintrust's own
 * agent integrations; tool calls are typed `tool` and carry their args.
 *
 * Child spans carry order but no duration: the CLI parsers leave each tool
 * call's `ts` timestamp at 0, so only the run's total duration is real. They
 * are pinned to `startTime` so the trace measures the run rather than the gap
 * between the run and the upload.
 */
function logTranscript(parent: Span, row: PendingRow): void {
  const at = row.startTime ? { startTime: row.startTime } : {};
  const ended = row.startTime ? { endTime: row.startTime } : undefined;
  let toolIndex = 0;
  // User turns become the next model call's input rather than spans of their
  // own, which is what the Thread view reads to render the conversation. The
  // scenario prompt starts it off: the harness doesn't put it in the
  // transcript, so without this a thread would open on the agent replying to
  // nothing.
  let pendingInput = row.prompt ? [{ role: 'user', content: row.prompt }] : [];

  for (const part of row.transcript) {
    if (part.type === 'message') {
      if (part.role === 'user') {
        pendingInput.push({ role: 'user', content: part.content });
        continue;
      }
      if (part.role === 'system') {
        const span = parent.startSpan({ name: 'system', type: 'task', ...at });
        span.log({ output: part.content });
        span.end(ended);
        continue;
      }
      const span = parent.startSpan({
        name: row.modelId ?? 'assistant',
        type: 'llm',
        ...at,
      });
      span.log({
        ...(pendingInput.length ? { input: pendingInput } : {}),
        output: [{ role: 'assistant', content: part.content }],
        ...(row.modelId ? { metadata: { model: row.modelId } } : {}),
      });
      span.end(ended);
      pendingInput = [];
      continue;
    }
    const label = row.toolLabels[toolIndex++];
    const span = parent.startSpan({
      name: label ? `${part.name}: ${label}` : part.name,
      type: 'tool',
      ...at,
    });
    span.log({
      input: part.input,
      ...(part.output !== undefined ? { output: part.output } : {}),
      ...(part.error ? { error: part.error } : {}),
    });
    span.end(ended);
  }

  // A user turn the agent never answered would otherwise be dropped.
  if (pendingInput.length) {
    const span = parent.startSpan({ name: 'user', type: 'task', ...at });
    span.log({ output: pendingInput });
    span.end(ended);
  }

  // The scorer, as its own span so the per-check breakdown has a home and
  // renders in Braintrust's scorer block rather than inside row metadata.
  const scorer = parent.startSpan({ name: 'passed', type: 'score', ...at });
  scorer.log({
    output: row.checks,
    scores: { passed: row.passed ? 1 : 0 },
  });
  scorer.end(ended);
}

async function main() {
  const projectId = process.env.BRAINTRUST_PROJECT_ID;
  if (!DRY && (!projectId || !process.env.BRAINTRUST_API_KEY)) {
    console.warn(
      '⚠️  BRAINTRUST_API_KEY / BRAINTRUST_PROJECT_ID unset — skipping upload.'
    );
    return;
  }

  const experimentMetadata = await loadExperimentMetadata();
  const byExperiment = await collectRows(experimentMetadata);
  if (byExperiment.size === 0) {
    console.log('No matching results to upload.');
    return;
  }

  const info = repoInfo();
  // 7-char prefix per Braintrust's per-commit guidance. Re-running an
  // unchanged commit is safe: the SDK suffixes a colliding name rather than
  // writing into the existing experiment.
  const sha7 = info?.commit?.slice(0, 7) ?? 'nogit';

  if (DRY) {
    for (const [experiment, rows] of byExperiment) {
      const evals = new Set(rows.map((row) => row.evalId)).size;
      console.log(
        `${experiment}@${sha7}: ${rows.length} row(s), ${evals} eval(s)`
      );
    }
    return;
  }

  const { init, flush } = await import('braintrust');

  for (const [experiment, rows] of byExperiment) {
    const name = `${experiment}@${sha7}`;
    const meta = experimentMetadata.get(experiment);
    const bt = init({
      projectId,
      experiment: name,
      repoInfo: info,
      metadata: {
        agent: meta?.display.agent,
        model_provider: meta?.display.modelProvider,
        model_id: meta?.display.modelId,
        reasoning_effort: meta?.display.reasoningEffort,
        experiment_suites: meta?.suites,
        ...prUrl(),
      },
    });

    for (const row of rows) {
      const root = bt.startSpan({
        name: row.evalId,
        type: 'eval',
        ...(row.startTime ? { startTime: row.startTime } : {}),
      });
      root.log({
        input: row.prompt,
        output: row.agentReport,
        scores: { passed: row.passed ? 1 : 0 },
        metadata: row.metadata,
        ...(Object.keys(row.metrics).length ? { metrics: row.metrics } : {}),
        ...(row.tags.length ? { tags: row.tags } : {}),
      });
      logTranscript(root, row);
      root.end(row.endTime ? { endTime: row.endTime } : undefined);
    }

    // The assigned name, not the requested one: Braintrust suffixes a
    // collision, so a re-run at the same commit reports its real name.
    const summary = await bt.summarize({ summarizeScores: false });
    console.log(`✅ ${summary.experimentName} → ${summary.experimentUrl}`);
  }

  await flush();
}

// Skipped on import (tests); runs only as the CLI entrypoint.
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  await main();
}
