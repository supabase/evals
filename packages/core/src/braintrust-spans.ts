/**
 * Pure mapping from a raw eval-result file to a Braintrust-shaped trace: one
 * root ("eval") row per result plus child spans — `llm` for assistant turns,
 * `tool` for tool calls, `task` for user/system messages, `score` for the
 * overall verdict and each scorer check.
 *
 * When the result carries the structured `trace` (AgentTrace, written by
 * runs since it landed), spans are hierarchical: turn llm spans own their
 * tool spans, and subagent sidechains nest under the tool call that spawned
 * them. Older results fall back to a flat sequence rebuilt from
 * `transcript[]`/`toolCalls[]`.
 *
 * Deliberately dependency-free (no braintrust import): this module only
 * builds a serializable tree; `apps/framework/scripts/upload-braintrust.ts`
 * walks it with the Braintrust SDK. That keeps the mapping unit-testable and
 * identical across agents (Claude Code, Codex, ai-sdk).
 *
 * Timing: CLI transcripts carry no per-event timestamps, so spans get
 * synthetic, evenly spread times across the run window purely to preserve
 * ordering in the Braintrust UI (children subdivide their parent's slot).
 * The root advertises this via `metadata.stepTiming = "synthetic-order-only"`.
 * The window itself is real when the result carries `startedAt`/`durationMs`
 * (new runs), else anchored at `baseTimeMs`.
 */

import { z } from "zod";
import { rawEvalResultSchema } from "./eval-metadata.js";
import type { AgentTrace, AgentTurn, ToolExecution } from "./transcript/agent-trace.js";

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

// Shallow guard for the structured trace: the runner one directory over is
// the only writer, so full recursive validation buys little — the mapper
// reads every field defensively.
const agentTraceSchema = z.custom<AgentTrace>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as AgentTrace).turns),
);

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
  trace: agentTraceSchema.optional(),
});
export type UploadableEvalResult = z.infer<typeof uploadableEvalResultSchema>;

export interface BraintrustSpanNode {
  name: string;
  type: "llm" | "tool" | "task" | "score";
  input?: unknown;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
  metrics?: Record<string, number>;
  scores?: Record<string, number>;
  children?: BraintrustSpanNode[];
  startMs: number;
  endMs: number;
}

/** A span node before the layout pass assigns its timing. */
type UnplacedSpan = Omit<BraintrustSpanNode, "startMs" | "endMs" | "children"> & {
  children?: UnplacedSpan[];
};

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

/** One llm span per turn, its tool spans (and subagent turns) nested. */
function turnSpans(trace: AgentTrace): UnplacedSpan[] {
  const spans: UnplacedSpan[] = [];
  const interjectionsAfter = new Map<number, UnplacedSpan[]>();
  for (const interjection of trace.interjections ?? []) {
    const group = interjectionsAfter.get(interjection.afterTurnIndex) ?? [];
    group.push({
      name: interjection.role,
      type: "task",
      output: capForUpload(interjection.content),
    });
    interjectionsAfter.set(interjection.afterTurnIndex, group);
  }

  spans.push(...(interjectionsAfter.get(-1) ?? []));
  for (const turn of trace.turns) {
    spans.push(turnSpan(turn));
    spans.push(...(interjectionsAfter.get(turn.index) ?? []));
  }
  return spans;
}

function turnSpan(turn: AgentTurn): UnplacedSpan {
  const output: Record<string, unknown> = {};
  if (turn.thinking) output.thinking = capForUpload(turn.thinking);
  if (turn.text) output.text = capForUpload(turn.text);
  const metadata: Record<string, unknown> = {};
  if (turn.messageId) metadata.messageId = turn.messageId;
  return {
    name: `turn ${turn.index + 1}`,
    type: "llm",
    ...(Object.keys(output).length > 0 ? { output } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(turn.usage ? { metrics: usageMetrics(turn.usage) } : {}),
    children: (turn.toolCalls ?? []).map(toolSpan),
  };
}

function toolSpan(execution: ToolExecution): UnplacedSpan {
  const metadata: Record<string, unknown> = {};
  if (execution.canonicalName && execution.canonicalName !== "tool_use") {
    metadata.tool = execution.canonicalName;
  }
  if (execution.path) metadata.path = execution.path;
  if (execution.command) metadata.command = execution.command;
  if (execution.url) metadata.url = execution.url;
  if (execution.loadedSkill) metadata.loadedSkill = execution.loadedSkill;
  return {
    name: execution.name,
    type: "tool",
    input: capForUpload(execution.args ?? {}),
    ...(execution.error === undefined
      ? { output: capForUpload(execution.output) }
      : { error: execution.error }),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    // A subagent sidechain renders as the Task call's own turn subtree.
    ...(execution.children?.length
      ? { children: execution.children.map(turnSpan) }
      : {}),
  };
}

/** Legacy flat fallback for results that predate the structured trace. */
function flatSpans(result: UploadableEvalResult): UnplacedSpan[] {
  const transcript = result.transcript ?? [];
  const toolCalls = result.toolCalls ?? [];
  const spans: UnplacedSpan[] = [];
  // The k-th tool_call transcript part and toolCalls[k] describe the same
  // call for CLI agents (the adapter pushes both in lockstep); the record
  // carries the normalized views the part lacks.
  let toolCallIndex = 0;
  for (const part of transcript) {
    if (part.type === "message") {
      spans.push({
        name: part.role,
        type: part.role === "assistant" ? "llm" : "task",
        output: capForUpload(part.content),
      });
      continue;
    }
    const candidate = toolCalls.at(toolCallIndex);
    toolCallIndex += 1;
    // ai-sdk populates toolCalls in completion order, which can differ from
    // the transcript's call order when tools run concurrently — only trust
    // the record when it names the same tool.
    const record =
      candidate && candidate.endpoint === part.name ? candidate : undefined;
    const metadata: Record<string, unknown> = {};
    if (record?.name) metadata.tool = record.name;
    if (record?.path) metadata.path = record.path;
    if (record?.command) metadata.command = record.command;
    if (record?.url) metadata.url = record.url;
    if (record?.loadedSkill) metadata.loadedSkill = record.loadedSkill;
    spans.push({
      name: part.name,
      type: "tool",
      input: capForUpload(part.input),
      output: part.error === undefined ? capForUpload(part.output) : undefined,
      ...(part.error !== undefined ? { error: part.error } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }
  return spans;
}

/**
 * Assign synthetic timing: siblings split their window into equal contiguous
 * slots, children subdivide their parent's slot. Order → position; durations
 * are not meaningful (see module comment).
 */
function layout(
  spans: UnplacedSpan[],
  startMs: number,
  endMs: number,
): BraintrustSpanNode[] {
  const slotMs = (endMs - startMs) / Math.max(spans.length, 1);
  return spans.map((span, index) => {
    const slotStart = startMs + index * slotMs;
    const slotEnd = startMs + (index + 1) * slotMs;
    const { children, ...rest } = span;
    return {
      ...rest,
      ...(children?.length
        ? { children: layout(children, slotStart, slotEnd) }
        : {}),
      startMs: slotStart,
      endMs: slotEnd,
    };
  });
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

  const hasStructuredTrace = (result.trace?.turns?.length ?? 0) > 0;
  const activity = hasStructuredTrace
    ? turnSpans(result.trace!)
    : flatSpans(result);

  const checks = result.checks ?? [];
  const scores: Record<string, number> = {
    passed: result.passed === true ? 1 : 0,
  };
  const takenScoreNames = new Set<string>(Object.keys(scores));
  // The overall verdict as its own score span — the trace-view counterpart of
  // eval-results.json's headline `passed`, ahead of the per-check spans.
  const scoreSpans: UnplacedSpan[] = [
    {
      name: "passed",
      type: "score",
      output: {
        passed: result.passed === true,
        checksPassed: `${checks.filter((c) => c.passed).length}/${checks.length}`,
      },
      scores: { passed: scores.passed! },
    },
  ];
  for (const check of checks) {
    const scoreName = scoreNameFor(check.name, takenScoreNames);
    const value = check.passed ? 1 : 0;
    scores[scoreName] = value;
    scoreSpans.push({
      name: scoreName,
      type: "score",
      output: {
        passed: check.passed,
        ...(check.notes ? { notes: check.notes } : {}),
        ...(check.judgeNotes ? { judgeNotes: check.judgeNotes } : {}),
      },
      scores: { [scoreName]: value },
    });
  }

  const unplaced = [...activity, ...scoreSpans];

  const parsedStart = result.startedAt ? Date.parse(result.startedAt) : NaN;
  const startMs = Number.isNaN(parsedStart) ? args.baseTimeMs : parsedStart;
  // Real window when the run recorded one; otherwise one synthetic second per
  // top-level span, purely so ordering survives.
  const durationMs = result.durationMs ?? Math.max(unplaced.length, 1) * 1000;
  const endMs = startMs + durationMs;
  const spans = layout(unplaced, startMs, endMs);

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
    ...(hasStructuredTrace && result.trace?.errors?.length
      ? { traceErrors: result.trace.errors }
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
