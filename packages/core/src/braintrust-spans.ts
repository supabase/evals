/**
 * Pure mapping from a raw eval-result file to a Braintrust-shaped trace: one
 * root ("eval") row per result plus an ordered list of child spans — `llm`
 * for assistant turns, `tool` for tool calls, `task` for user/system
 * messages, `score` for scorer checks.
 *
 * Deliberately dependency-free (no braintrust import): this module only
 * builds a serializable tree; `apps/framework/scripts/upload-braintrust.ts`
 * walks it with the Braintrust SDK. That keeps the mapping unit-testable and
 * identical across agents (Claude Code, Codex, ai-sdk), since it reads the
 * canonical transcript the harness already persists.
 *
 * Timing: CLI transcripts carry no per-event timestamps (every persisted
 * `toolCalls[].ts` is 0 today), so child spans get synthetic, evenly spread
 * times across the run window purely to preserve ordering in the Braintrust
 * UI. The root advertises this via `metadata.stepTiming =
 * "synthetic-order-only"`. The window itself is real when the result carries
 * `startedAt`/`durationMs` (new runs), else anchored at `baseTimeMs`.
 */

import { z } from "zod";
import { rawEvalResultSchema } from "./eval-metadata.js";

const transcriptPartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
  }),
  z.object({
    type: z.literal("tool_call"),
    name: z.string(),
    input: z.record(z.string(), z.unknown()).default({}),
    output: z.unknown().optional(),
    error: z.string().optional(),
  }),
]);

const toolCallRecordSchema = z.looseObject({
  endpoint: z.string(),
  body: z.record(z.string(), z.unknown()).default({}),
  name: z.string().optional(),
  path: z.string().optional(),
  command: z.string().optional(),
  url: z.string().optional(),
  loadedSkill: z.string().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  ts: z.number().default(0),
});

const agentUsageSchema = z
  .object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cachedInputTokens: z.number(),
    cacheCreationInputTokens: z.number(),
    reasoningTokens: z.number(),
    totalTokens: z.number(),
    costUsd: z.number(),
  })
  .partial();

/**
 * A raw result file as the uploader consumes it: the exported shape plus the
 * transcript fields the web export drops. Everything beyond the base shape is
 * optional so results written before these fields existed still upload.
 */
export const uploadableEvalResultSchema = rawEvalResultSchema.extend({
  transcript: z.array(transcriptPartSchema).optional(),
  toolCalls: z.array(toolCallRecordSchema).optional(),
  agentReport: z.string().optional(),
  stoppedReason: z.string().optional(),
  steps: z.number().optional(),
  usage: agentUsageSchema.optional(),
  startedAt: z.string().optional(),
  durationMs: z.number().optional(),
});
export type UploadableEvalResult = z.infer<typeof uploadableEvalResultSchema>;

export interface BraintrustSpanNode {
  name: string;
  type: "llm" | "tool" | "task" | "score";
  input?: unknown;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
  scores?: Record<string, number>;
  startMs: number;
  endMs: number;
}

export interface BraintrustEvalTrace {
  evalId: string;
  experiment: string;
  input: unknown;
  output?: unknown;
  scores: Record<string, number>;
  metadata: Record<string, unknown>;
  metrics: Record<string, number>;
  tags: string[];
  startMs: number;
  endMs: number;
  spans: BraintrustSpanNode[];
}

/**
 * Braintrust rejects oversized events; cap any single logged value well below
 * that so one giant tool output can't sink the whole row.
 */
const MAX_FIELD_CHARS = 100_000;
const TRUNCATION_PREVIEW_CHARS = 20_000;

function capForUpload(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") {
    if (value.length <= MAX_FIELD_CHARS) return value;
    return `${value.slice(0, TRUNCATION_PREVIEW_CHARS)}\n…[truncated ${value.length} chars]`;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
  if (serialized.length <= MAX_FIELD_CHARS) return value;
  return {
    truncated: true,
    chars: serialized.length,
    preview: serialized.slice(0, TRUNCATION_PREVIEW_CHARS),
  };
}

/** Unique, human-readable score name per check; `passed` is reserved. */
function scoreNameFor(checkName: string, taken: Set<string>): string {
  const base = checkName.trim() || "check";
  let name = base === "passed" ? "check: passed" : base;
  for (let n = 2; taken.has(name); n += 1) name = `${base} (${n})`;
  taken.add(name);
  return name;
}

function usageMetrics(
  usage: UploadableEvalResult["usage"],
): Record<string, number> {
  if (!usage) return {};
  const metrics: Record<string, number> = {};
  // Braintrust's conventional metric names, so its token columns light up.
  if (usage.inputTokens !== undefined) metrics.prompt_tokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) metrics.completion_tokens = usage.outputTokens;
  if (usage.cachedInputTokens !== undefined) {
    metrics.prompt_cached_tokens = usage.cachedInputTokens;
  }
  if (usage.cacheCreationInputTokens !== undefined) {
    metrics.prompt_cache_creation_tokens = usage.cacheCreationInputTokens;
  }
  if (usage.reasoningTokens !== undefined) {
    metrics.completion_reasoning_tokens = usage.reasoningTokens;
  }
  const total =
    usage.totalTokens ??
    (usage.inputTokens !== undefined || usage.outputTokens !== undefined
      ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      : undefined);
  if (total !== undefined) metrics.tokens = total;
  return metrics;
}

export function buildEvalTrace(args: {
  experiment: string;
  result: UploadableEvalResult;
  /** Scenario prompt (PROMPT.md body), when resolvable. */
  prompt?: string;
  /** Extra root metadata from the caller (source paths, git info, …). */
  extraMetadata?: Record<string, unknown>;
  /** Anchor for synthetic timing when the result carries no `startedAt`. */
  baseTimeMs: number;
}): BraintrustEvalTrace {
  const { result } = args;

  const parsedStart = result.startedAt ? Date.parse(result.startedAt) : NaN;
  const startMs = Number.isNaN(parsedStart) ? args.baseTimeMs : parsedStart;

  const transcript = result.transcript ?? [];
  const toolCalls = result.toolCalls ?? [];
  const checks = result.checks ?? [];
  const spanCount = transcript.length + checks.length;
  // Real window when the run recorded one; otherwise one synthetic second per
  // span, purely so ordering survives.
  const durationMs = result.durationMs ?? Math.max(spanCount, 1) * 1000;
  const endMs = startMs + durationMs;
  const slotMs = durationMs / Math.max(spanCount, 1);
  const slot = (index: number): { startMs: number; endMs: number } => ({
    startMs: startMs + index * slotMs,
    endMs: startMs + (index + 1) * slotMs,
  });

  const spans: BraintrustSpanNode[] = [];
  // The k-th tool_call transcript part and toolCalls[k] describe the same
  // call (the adapter pushes both in lockstep); the record carries the
  // normalized views the part lacks.
  let toolCallIndex = 0;
  for (const part of transcript) {
    const timing = slot(spans.length);
    if (part.type === "message") {
      spans.push({
        name: part.role,
        type: part.role === "assistant" ? "llm" : "task",
        output: capForUpload(part.content),
        ...timing,
      });
      continue;
    }
    const record = toolCalls.at(toolCallIndex);
    toolCallIndex += 1;
    const normalized: Record<string, unknown> = {};
    if (record?.name) normalized.tool = record.name;
    if (record?.path) normalized.path = record.path;
    if (record?.command) normalized.command = record.command;
    if (record?.url) normalized.url = record.url;
    if (record?.loadedSkill) normalized.loadedSkill = record.loadedSkill;
    spans.push({
      name: part.name,
      type: "tool",
      input: capForUpload(part.input),
      output: part.error === undefined ? capForUpload(part.output) : undefined,
      ...(part.error !== undefined ? { error: part.error } : {}),
      ...(Object.keys(normalized).length > 0 ? { metadata: normalized } : {}),
      ...timing,
    });
  }

  const scores: Record<string, number> = {
    passed: result.passed === true ? 1 : 0,
  };
  const takenScoreNames = new Set<string>(Object.keys(scores));
  for (const check of checks) {
    const scoreName = scoreNameFor(check.name, takenScoreNames);
    const value = check.passed ? 1 : 0;
    scores[scoreName] = value;
    spans.push({
      name: scoreName,
      type: "score",
      output: {
        passed: check.passed,
        ...(check.notes ? { notes: check.notes } : {}),
        ...(check.judgeNotes ? { judgeNotes: check.judgeNotes } : {}),
      },
      scores: { [scoreName]: value },
      ...slot(spans.length),
    });
  }

  const display = result.experimentDisplay;
  const metadata: Record<string, unknown> = {
    eval: result.eval,
    experiment: args.experiment,
    ...(result.experimentSuite ?? result.profile
      ? { experimentSuite: result.experimentSuite ?? result.profile }
      : {}),
    ...(display ? { ...display } : {}),
    ...(result.stage ? { stage: result.stage } : {}),
    ...(result.product ? { product: result.product } : {}),
    ...(result.topic ? { topic: result.topic } : {}),
    ...(result.suite ? { suite: result.suite } : {}),
    ...(result.interface ? { interface: result.interface } : {}),
    ...(result.cliVersion ? { cliVersion: result.cliVersion } : {}),
    ...(result.attempts !== undefined ? { attempts: result.attempts } : {}),
    ...(result.steps !== undefined ? { steps: result.steps } : {}),
    ...(result.stoppedReason ? { stoppedReason: result.stoppedReason } : {}),
    ...(result.skills ? { skills: result.skills } : {}),
    ...(result.docs ? { docs: result.docs } : {}),
    ...(result.usage?.costUsd !== undefined
      ? { costUsd: result.usage.costUsd }
      : {}),
    stepTiming: "synthetic-order-only",
    ...args.extraMetadata,
  };

  return {
    evalId: result.eval,
    experiment: args.experiment,
    // The prompt is the comparison key across experiments (Braintrust matches
    // rows by input); fall back to the eval id so old results still line up.
    input: args.prompt ?? { eval: result.eval },
    ...(result.agentReport ? { output: capForUpload(result.agentReport) } : {}),
    scores,
    metadata,
    metrics: usageMetrics(result.usage),
    tags: [
      ...(result.stage ? [result.stage] : []),
      ...(result.product ?? []),
      ...(result.topic ?? []),
      ...(result.interface ? [result.interface] : []),
    ],
    startMs,
    endMs,
    spans,
  };
}
