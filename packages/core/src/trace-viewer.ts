/**
 * Adapter from an eval run's recorded surface (`transcript` + `toolCalls` +
 * `skills` + `checks`) to the AgentPrism `TraceSpan` tree the web viewer
 * renders. Pure data: no React, no transport — the web `trace-panel` fetches
 * the serialized output of this function from `apps/web/src/data/traces/`.
 *
 * Pairing: `adaptTranscript` pushes `TranscriptPart`s (messages and tool
 * calls) and `ToolCallRecord`s in the same event order, so the i-th
 * `tool_call` part corresponds to `toolCalls[i]` (matched here by walking a
 * shared counter rather than by name, which isn't unique across runs).
 *
 * Token accounting: each assistant `TranscriptPart` carries real per-turn
 * `usage` (from ai-sdk's `step.usage` or the CLI agent's own usage event —
 * see `TokenUsage` in transcript/types.ts). An `Assistant`/`llm_call` span's
 * `tokensCount` is that turn's own cost. The cost of loading a skill is the
 * *context growth* it causes: `inputTokens` is cumulative context size, so
 * the jump between one assistant turn's `inputTokens` and the next is what
 * everything between them (skill loads, other tool results) added to context.
 * That delta is attributed to any `load_skill` tool-execution spans in the
 * gap (split evenly if more than one loaded before the next turn) — an
 * honest per-turn-boundary number, not a per-skill-body byte count.
 */

import type {
  TraceRecord,
  TraceSpan,
  TraceSpanAttribute,
  TraceSpanStatus,
} from '@evilmartians/agent-prism-types';
import type { CheckResult, SkillResult } from './eval-metadata.js';
import type { ToolCallRecord, TranscriptPart } from './index.js';
import type { TokenUsage } from './transcript/types.js';

/** Plain-data badge the web layer maps to a styled `<Badge>`. */
export interface TraceBadge {
  label: string;
  tone: 'success' | 'error' | 'warning' | 'neutral';
}

export interface TraceViewerData {
  traceRecord: TraceRecord;
  spans: TraceSpan[];
  badges: TraceBadge[];
}

export interface EvalResultTraceInput {
  evalId: string;
  passed?: boolean;
  transcript?: TranscriptPart[];
  toolCalls?: ToolCallRecord[];
  agentReport?: string;
  skills?: SkillResult;
  checks?: CheckResult[];
  experimentDisplay?: {
    agent?: string;
    modelId?: string;
    modelProvider?: string;
  };
  attempts?: number;
}

export function evalResultToTraceSpans(
  input: EvalResultTraceInput
): TraceViewerData {
  const {
    evalId,
    passed,
    transcript = [],
    toolCalls = [],
    agentReport = '',
    skills,
    checks = [],
    experimentDisplay,
    attempts,
  } = input;

  const loaded = skills?.loaded ?? [];
  const available = skills?.available ?? [];

  const children: TraceSpan[] = [];
  // Real wall-clock position per child (parallel to `children`), used for the
  // duration pass below. `undefined` until the first real `ts` arrives (the
  // seeded system/user prompt has none) — never fabricated, so a trace from
  // an agent/path with no timing data (e.g. Codex's --json stream) honestly
  // stays at 0ms everywhere rather than showing invented numbers.
  const childTs: (number | undefined)[] = [];
  let clock: number | undefined;
  const advance = (ts: number | undefined): number | undefined => {
    if (ts !== undefined)
      clock = clock === undefined ? ts : Math.max(clock, ts);
    return clock;
  };
  let spanSeq = 0;
  let toolIdx = 0;
  const nextId = (prefix: string) => `${evalId}-${prefix}-${++spanSeq}`;

  // A "turn" is any transcript part carrying usage — an assistant message OR
  // a tool_call (a turn is often tool-call-only, e.g. loading a skill
  // produces no text; see TranscriptPart.usage). `inputTokens` at turn N is
  // the context size BEFORE that turn's model call, so the jump between turn
  // N and turn N+1 is what turn N itself (its own output plus its tool
  // results — skill bodies included) added to context. `pendingLoadSpans`
  // accumulates load_skill spans since the last resolved delta, INCLUDING
  // ones from the turn that's only now closing — they aren't resolvable
  // until the *following* turn's usage arrives, so they must not be cleared
  // when that turn's own recordTurn call runs, only after the next one uses
  // them.
  let lastTurnInputTokens: number | undefined;
  let pendingLoadSpans: number[] = [];
  const skillLoadDeltas: { childIndex: number; tokensAdded: number }[] = [];
  let totalTokens: number | undefined;

  const recordTurn = (usage: TokenUsage | undefined) => {
    if (usage?.inputTokens === undefined) return;
    if (lastTurnInputTokens !== undefined) {
      const delta = usage.inputTokens - lastTurnInputTokens;
      // A positive jump in context size since the LAST RESOLVED delta is what
      // every load_skill call since then added — including ones that closed
      // their own turn before this one (a turn's own inputTokens is a
      // baseline BEFORE its own tool calls' results land in context; those
      // results, skill bodies included, only show up in the NEXT turn's
      // inputTokens). Split evenly across load_skill spans in that gap; a
      // negative or zero delta (context compaction, or nothing loaded)
      // attributes nothing. Approximate — this can't isolate a skill load's
      // cost from a same-gap non-skill tool result's — but it's real usage,
      // not a byte-count guess. pendingLoadSpans is intentionally NOT cleared
      // when there's no prior baseline (the branch below) — a load before the
      // run's first resolvable turn still needs to survive to be attributed
      // by whichever LATER turn's delta first captures its result landing in
      // context.
      if (delta > 0 && pendingLoadSpans.length > 0) {
        const share = Math.round(delta / pendingLoadSpans.length);
        for (const idx of pendingLoadSpans) {
          skillLoadDeltas.push({ childIndex: idx, tokensAdded: share });
        }
      }
      pendingLoadSpans = [];
    }
    lastTurnInputTokens = usage.inputTokens;
  };

  for (const part of transcript) {
    if (part.type === 'message') {
      const isAssistant = part.role === 'assistant';
      const tokensCount = isAssistant ? totalOf(part.usage) : undefined;
      if (tokensCount !== undefined)
        totalTokens = (totalTokens ?? 0) + tokensCount;
      const spanTs = advance(part.ts);
      children.push(
        makeSpan({
          id: nextId(isAssistant ? 'llm' : 'msg'),
          title: isAssistant
            ? 'Assistant'
            : part.role === 'system'
              ? 'System'
              : 'User',
          type: isAssistant ? 'llm_call' : 'event',
          status: 'success',
          clock: spanTs ?? 0,
          // Assistant content is the model's output; user/system content is
          // what fed IN to that turn — the AgentPrism In/Out tab only shows
          // an "Input" section when `input` is set, so a user prompt landing
          // in `output` renders mislabeled (and empty "Input" section).
          ...(isAssistant ? { output: part.content } : { input: part.content }),
          tokensCount,
        })
      );
      childTs.push(spanTs);
      if (isAssistant) recordTurn(part.usage);
      continue;
    }

    // tool_call: pair with the next ToolCallRecord (same order as adaptTranscript).
    // Prefer the ToolCallRecord's own `ts` — for ai-sdk it's captured live per
    // call via experimental_onToolCallFinish, finer-grained than the part's
    // own step-level ts (a step can hold several tool calls, one timestamp).
    const rec = toolCalls[toolIdx++];
    const recTs = rec && rec.ts > 0 ? rec.ts : undefined;
    const spanTs = advance(recTs ?? part.ts);
    const attrs: TraceSpanAttribute[] = (rec?.loadedSkills ?? []).map(
      (name) => ({
        key: 'skill',
        value: { stringValue: name },
      })
    );
    children.push(
      makeSpan({
        id: nextId('tool'),
        title: `Tool: ${part.name}`,
        type: 'tool_execution',
        status: part.error ? 'error' : 'success',
        clock: spanTs ?? 0,
        input: safeStringify(part.input),
        output:
          part.error ??
          (part.output !== undefined ? safeStringify(part.output) : undefined),
        attributes: attrs.length > 0 ? attrs : undefined,
        // A tool span's cost is only ever known via the delta-attribution
        // pass below (its own turn-usage, if it happens to close a turn, is
        // a running context total, not a marginal cost — not meaningful here).
      })
    );
    childTs.push(spanTs);
    if (attrs.length > 0) pendingLoadSpans.push(children.length - 1);
    if (part.usage) recordTurn(part.usage);
  }

  // Apply the attributed skill-load costs computed above — the only source
  // of tokensCount on a tool_execution span. Done as a second pass (mutating
  // already-built spans) since a load's cost is only known once the
  // *following* turn's usage arrives. Not added to totalTokens: a load's
  // attributed cost is already part of the following turn's own inputTokens,
  // which that turn's own tokensCount (summed above) already counts —
  // adding it again here would double-count it.
  for (const { childIndex, tokensAdded } of skillLoadDeltas) {
    children[childIndex].tokensCount = tokensAdded;
  }

  // Every check gets its own event span — a "true reflection" of scoring
  // means showing what passed too, not just what a failed run got wrong.
  // Checks are computed AFTER the run, not during it — no real timing of
  // their own, so they sit at the trace's final known position (0 duration).
  for (const check of checks) {
    children.push(
      makeSpan({
        id: nextId('check'),
        title: `${check.passed ? 'Check passed' : 'Check failed'}: ${check.name}`,
        type: 'event',
        status: check.passed ? 'success' : 'error',
        clock: clock ?? 0,
        output: check.notes ?? check.judgeNotes ?? '',
      })
    );
    childTs.push(clock);
  }

  // Second pass: a span's real duration is the gap to whatever comes right
  // after it — only computable once every child's position is known, and
  // only when BOTH ends of the gap have a real timestamp (never fabricated;
  // a gap touching an untimed part — e.g. the seeded system/user prompt, or
  // any part from an agent path with no timing data — stays at 0ms).
  for (let i = 0; i < children.length - 1; i++) {
    const t0 = childTs[i];
    const t1 = childTs[i + 1];
    if (t0 !== undefined && t1 !== undefined && t1 > t0) {
      children[i]!.duration = t1 - t0;
      children[i]!.endTime = new Date(t1);
    }
  }
  const realTs = childTs.filter((t): t is number => t !== undefined);
  const rootStart = realTs[0] ?? 0;
  const rootEnd = realTs[realTs.length - 1] ?? rootStart;

  // Spans with no real timestamp were built with `clock: 0` (Unix epoch) so
  // their own duration honestly reads 0ms — but that same epoch value, left
  // as their startTime/endTime, corrupts the trace-wide min/max the timeline
  // bar uses to scale every span: one epoch-dated span makes minStart ~56
  // years earlier than the rest of the trace, shrinking every real span's
  // bar to an invisible sliver. Snap them to the trace's own start instead —
  // still a 0-duration marker, just positioned inside the real range.
  for (let i = 0; i < children.length; i++) {
    if (childTs[i] === undefined) {
      children[i]!.startTime = new Date(rootStart);
      children[i]!.endTime = new Date(rootStart);
    }
  }

  const rootStatus: TraceSpanStatus = passed ? 'success' : 'error';
  const root = makeSpan({
    id: `eval:${evalId}`,
    title: evalId,
    type: 'agent_invocation',
    status: rootStatus,
    clock: rootStart,
    output: agentReport,
    children,
  });
  root.endTime = new Date(rootEnd);
  root.duration = rootEnd - rootStart;
  root.tokensCount = totalTokens;

  const spansCount = countSpans([root]);
  const agentDescription =
    experimentDisplay?.modelId ?? experimentDisplay?.agent ?? '';

  const traceRecord: TraceRecord = {
    id: evalId,
    name: evalId,
    spansCount,
    durationMs: root.duration,
    agentDescription,
    totalTokens,
  };

  const badges: TraceBadge[] = [
    { label: passed ? 'Passed' : 'Failed', tone: passed ? 'success' : 'error' },
  ];
  if (available.length > 0) {
    badges.push({
      label: `${loaded.length}/${available.length} skills`,
      tone: loaded.length > 0 ? 'success' : 'neutral',
    });
  }
  if (attempts && attempts > 1) {
    badges.push({ label: `${attempts} attempts`, tone: 'warning' });
  }
  if (experimentDisplay?.modelId) {
    badges.push({ label: experimentDisplay.modelId, tone: 'neutral' });
  }

  return { traceRecord, spans: [root], badges };
}

// ── helpers ────────────────────────────────────────────────────────────────

interface MakeSpanInput {
  id: string;
  title: string;
  type: TraceSpan['type'];
  status: TraceSpanStatus;
  clock: number;
  input?: string;
  output?: string;
  attributes?: TraceSpanAttribute[];
  children?: TraceSpan[];
  tokensCount?: number;
}

function makeSpan(input: MakeSpanInput): TraceSpan {
  const start = new Date(input.clock);
  return {
    id: input.id,
    title: input.title,
    startTime: start,
    endTime: start,
    duration: 0,
    type: input.type,
    status: input.status,
    raw: input.output ?? input.input ?? '',
    ...(input.input !== undefined ? { input: input.input } : {}),
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.attributes ? { attributes: input.attributes } : {}),
    ...(input.children ? { children: input.children } : {}),
    ...(input.tokensCount !== undefined
      ? { tokensCount: input.tokensCount }
      : {}),
  };
}

/** Sum of input+output tokens for one turn's usage, when both are known. */
function totalOf(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined;
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    return usage.inputTokens + usage.outputTokens;
  }
  return undefined;
}

function countSpans(spans: TraceSpan[]): number {
  let n = 0;
  for (const s of spans) {
    n += 1;
    if (s.children) n += countSpans(s.children);
  }
  return n;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
