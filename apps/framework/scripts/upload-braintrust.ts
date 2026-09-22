#!/usr/bin/env tsx
/**
 * Uploads scored runs with one Braintrust experiment per local experiment and
 * one row per run. Agent messages and tool calls become child spans.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { AgentUsage } from '@supabase-evals/core/eval-metadata';
import {
  normalizeExperimentName,
  readFlag,
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
import type { Span } from 'braintrust';

const rawArgs = process.argv.slice(2);
const EXPERIMENT_FILTERS = readRepeatedFlag(rawArgs, 'experiment').map(
  normalizeExperimentName
);
const EVAL_FILTERS = readRepeatedFlag(rawArgs, 'eval');
const SUITE_FILTERS = readSuiteFilters(rawArgs);
const DRY = rawArgs.includes('--dry');
// `eval:upload` passes this cutoff to select files written by its run.
const SINCE = Number(readFlag(rawArgs, 'since') ?? 0);

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
  toolLabels: (string | undefined)[];
  metadata: Record<string, unknown>;
  tags: string[];
  metrics: Record<string, number>;
  /** Unix seconds. */
  startTime?: number;
  endTime?: number;
}

function git(...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      // Most commits have no exact tag, so suppress the expected error.
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

// A detached Actions checkout reports `HEAD`, so prefer its branch variables.
// https://docs.github.com/en/actions/reference/workflows-and-actions/variables
function branchName(): string | undefined {
  return (
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    git('rev-parse', '--abbrev-ref', 'HEAD')
  );
}

function repoInfo() {
  const commit = git('rev-parse', 'HEAD');
  if (!commit) {
    return undefined;
  }
  return {
    commit,
    branch: branchName(),
    tag: git('describe', '--tags', '--exact-match') ?? null,
    dirty: (git('status', '--porcelain') ?? '') !== '',
    author_name: git('log', '-1', '--format=%an'),
    author_email: git('log', '-1', '--format=%ae'),
    commit_message: git('log', '-1', '--format=%s'),
    commit_time: git('log', '-1', '--format=%cI'),
  };
}

/**
 * `inputTokens` already includes cache buckets, matching Braintrust's
 * `prompt_tokens` convention.
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
    prompt += u.inputTokens ?? 0;
    cached += u.cacheReadInputTokens ?? 0;
    cacheCreate += u.cacheWriteInputTokens ?? 0;
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

function summarize(command: string): string {
  const line = command.trim().replace(/\s+/g, ' ');
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

function prUrl(): Record<string, string> {
  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = process.env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//)?.[1];
  return repo && prNumber
    ? { pr_url: `https://github.com/${repo}/pull/${prNumber}` }
    : {};
}

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
    // Results record duration but no start time, so derive it from file mtime.
    const { mtimeMs } = await stat(absolutePath);
    if (mtimeMs < SINCE) {
      continue;
    }
    const endTime = durationMs ? mtimeMs / 1000 : undefined;

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
        // Preserve the harness's own step and tool-call counts.
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

function logTranscript(parent: Span, row: PendingRow): void {
  // Parsers lack per-entry timestamps, so keep child spans at the run start.
  const at = row.startTime ? { startTime: row.startTime } : {};
  const ended = row.startTime ? { endTime: row.startTime } : undefined;
  let toolIndex = 0;
  // Seed the next assistant input with the prompt omitted from the transcript.
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

  // Preserve a trailing user message with no assistant response.
  if (pendingInput.length) {
    const span = parent.startSpan({ name: 'user', type: 'task', ...at });
    span.log({ output: pendingInput });
    span.end(ended);
  }

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
  // Distinguishes repeated runs on the same branch.
  const runId = randomUUID();

  if (DRY) {
    for (const [experiment, rows] of byExperiment) {
      const evals = new Set(rows.map((row) => row.evalId)).size;
      console.log(`${experiment}: ${rows.length} row(s), ${evals} eval(s)`);
    }
    return;
  }

  const { init, flush } = await import('braintrust');

  for (const [experiment, rows] of byExperiment) {
    const meta = experimentMetadata.get(experiment);
    const bt = init({
      projectId,
      experiment,
      repoInfo: info,
      metadata: {
        agent: meta?.display.agent,
        model_provider: meta?.display.modelProvider,
        model_id: meta?.display.modelId,
        reasoning_effort: meta?.display.reasoningEffort,
        experiment_suites: meta?.suites,
        run_id: runId,
        // Duplicated from repo_info because grouping only reads metadata.
        ...(info?.branch ? { branch: info.branch } : {}),
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

    const summary = await bt.summarize({ summarizeScores: false });
    console.log(`✅ ${summary.experimentName} → ${summary.experimentUrl}`);
  }

  await flush();
}

// Keep imports inert in tests.
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  await main();
}
