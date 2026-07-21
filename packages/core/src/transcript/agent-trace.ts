/**
 * Structured, agent-agnostic transcript.
 *
 * A **turn** is everything the agent does between user inputs — one user
 * prompt in, all autonomous work until the next user input. Evals send a
 * single prompt, so most traces have exactly one turn (a mid-run injected
 * user message, e.g. a skill body, opens a new one). Inside a turn, a
 * **step** is one model API call: its thinking, assistant text, and the tool
 * executions it requested, with results paired at assembly time and subagent
 * sidechains nested under the tool call that spawned them.
 *
 * Assembled from the same canonical `TranscriptEvent[]` the flat scorer
 * surface (`adaptTranscript`) consumes, so the two views can never disagree
 * about what happened; this one just stops throwing the structure away.
 * Step grouping uses `event.turnKey` when the parser stamped one (Claude
 * Code: one assistant line = one API message; ai-sdk builds steps directly)
 * and otherwise falls back to a closure rule: thinking and tool calls
 * accumulate into the open step, an assistant message closes it (Codex's
 * item stream).
 */

import type { AgentUsage } from "../index.js";
import type { ToolName, TranscriptEvent } from "./types.js";

export interface ToolExecution {
  /** Correlation id, when the harness provides one. */
  id?: string;
  /** Original tool name as the agent emitted it. */
  name: string;
  /** Canonical cross-agent tool category. */
  canonicalName: ToolName;
  args: Record<string, unknown>;
  /** Normalized arg views (see TranscriptEvent.tool). */
  path?: string;
  command?: string;
  url?: string;
  loadedSkill?: string;
  output?: unknown;
  error?: string;
  success?: boolean;
  /** Epoch-ms timing when the transcript carries real timestamps. */
  startMs?: number;
  /** Subagent sidechain (e.g. Claude Code Task) spawned by this call. */
  children?: AgentStep[];
}

/** One model API call within a turn. */
export interface AgentStep {
  index: number;
  /** Provider message id of the API call, when exposed. */
  messageId?: string;
  /** Per-call token usage, when the transcript carries it. */
  usage?: AgentUsage;
  startMs?: number;
  thinking?: string;
  /** Assistant prose (absent on pure-tool steps). */
  text?: string;
  toolCalls: ToolExecution[];
}

/** Everything the agent did between two user inputs. */
export interface AgentTurn {
  index: number;
  /**
   * The user/system message that opened this turn. Absent on the first turn
   * — the eval prompt itself lives on the result, not in the transcript.
   */
  userMessage?: string;
  steps: AgentStep[];
}

export interface AgentTrace {
  turns: AgentTurn[];
  /** Agent-reported error events, in order. */
  errors: string[];
}

function parseMs(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}

export function assembleAgentTrace(events: TranscriptEvent[]): AgentTrace {
  // Split sidechain events (subagent activity) from the main thread; each
  // group is assembled recursively and attached to its spawning tool call.
  const main: TranscriptEvent[] = [];
  const sidechains = new Map<string, TranscriptEvent[]>();
  for (const event of events) {
    if (event.parentToolUseId) {
      const group = sidechains.get(event.parentToolUseId) ?? [];
      group.push({ ...event, parentToolUseId: undefined });
      sidechains.set(event.parentToolUseId, group);
    } else {
      main.push(event);
    }
  }

  const turns: AgentTurn[] = [];
  const errors: string[] = [];
  const executionsById = new Map<string, ToolExecution>();
  const stepsByKey = new Map<string, AgentStep>();
  let stepCount = 0;
  // Closure-rule state for events without a turnKey: an assistant message
  // marks the open step closed, so the next event starts a fresh one.
  let openStep: AgentStep | undefined;
  let openStepClosed = false;
  // A user/system message between steps opens the next turn; consecutive
  // boundary messages fold into one.
  let pendingUserMessage: string | undefined;

  const currentTurn = (): AgentTurn => {
    if (turns.length === 0 || pendingUserMessage !== undefined) {
      const turn: AgentTurn = {
        index: turns.length,
        ...(pendingUserMessage !== undefined
          ? { userMessage: pendingUserMessage }
          : {}),
        steps: [],
      };
      pendingUserMessage = undefined;
      turns.push(turn);
      return turn;
    }
    return turns[turns.length - 1]!;
  };

  const newStep = (event: TranscriptEvent): AgentStep => {
    const step: AgentStep = { index: stepCount, toolCalls: [] };
    stepCount += 1;
    const startMs = parseMs(event.timestamp);
    if (startMs !== undefined) step.startMs = startMs;
    currentTurn().steps.push(step);
    return step;
  };

  const stepFor = (event: TranscriptEvent): AgentStep => {
    if (event.turnKey) {
      const existing = stepsByKey.get(event.turnKey);
      if (existing) return existing;
      const step = newStep(event);
      stepsByKey.set(event.turnKey, step);
      return step;
    }
    if (!openStep || openStepClosed) {
      openStep = newStep(event);
      openStepClosed = false;
    }
    return openStep;
  };

  for (const event of main) {
    if (event.type === "error") {
      if (event.content) errors.push(event.content);
      continue;
    }

    if (event.type === "message" && event.role && event.role !== "assistant") {
      const content = event.content?.trim();
      if (content) {
        pendingUserMessage =
          pendingUserMessage === undefined
            ? content
            : `${pendingUserMessage}\n\n${content}`;
        // A user input also ends whatever keyless step was open.
        openStepClosed = true;
      }
      continue;
    }

    if (event.type === "tool_result") {
      const execution = event.tool?.id
        ? executionsById.get(event.tool.id)
        : undefined;
      if (execution && event.tool) {
        if (event.tool.success === false) {
          execution.error =
            typeof event.tool.result === "string"
              ? event.tool.result
              : JSON.stringify(event.tool.result);
        } else {
          execution.output = event.tool.result;
        }
        if (event.tool.success !== undefined) {
          execution.success = event.tool.success;
        }
      }
      continue;
    }

    if (event.type === "message" && event.role === "assistant") {
      const step = stepFor(event);
      const content = event.content?.trim();
      if (content) {
        step.text = step.text ? `${step.text}\n${content}` : content;
      }
      annotate(step, event);
      if (!event.turnKey) openStepClosed = true;
      continue;
    }

    if (event.type === "thinking") {
      const step = stepFor(event);
      const content = event.content?.trim();
      if (content) {
        step.thinking = step.thinking
          ? `${step.thinking}\n${content}`
          : content;
      }
      annotate(step, event);
      continue;
    }

    if (event.type === "tool_call" && event.tool) {
      const step = stepFor(event);
      const execution: ToolExecution = {
        ...(event.tool.id ? { id: event.tool.id } : {}),
        name: event.tool.originalName,
        canonicalName: event.tool.name,
        args: event.tool.args ?? {},
        ...(event.tool.path ? { path: event.tool.path } : {}),
        ...(event.tool.command ? { command: event.tool.command } : {}),
        ...(event.tool.url ? { url: event.tool.url } : {}),
        ...(event.tool.loadedSkill
          ? { loadedSkill: event.tool.loadedSkill }
          : {}),
      };
      const startMs = parseMs(event.timestamp);
      if (startMs !== undefined) execution.startMs = startMs;
      step.toolCalls.push(execution);
      if (execution.id) executionsById.set(execution.id, execution);
      annotate(step, event);
    }
  }

  // A trailing user message with no assistant activity after it still opens
  // an (empty) turn, so it isn't silently dropped.
  if (pendingUserMessage !== undefined) {
    turns.push({
      index: turns.length,
      userMessage: pendingUserMessage,
      steps: [],
    });
  }

  // Attach sidechains to their spawning tool call; groups whose parent call
  // never appeared (truncated transcript) surface as an error note instead
  // of vanishing.
  for (const [parentId, group] of sidechains) {
    const parent = executionsById.get(parentId);
    const subTrace = assembleAgentTrace(group);
    errors.push(...subTrace.errors);
    const subSteps = subTrace.turns.flatMap((turn) => turn.steps);
    if (parent) {
      parent.children = subSteps;
    } else if (subSteps.length > 0) {
      errors.push(
        `orphaned subagent transcript (parent tool_use ${parentId} not found)`,
      );
    }
  }

  return { turns, errors };
}

/** Fold an event's per-call identifiers/usage onto its step. */
function annotate(step: AgentStep, event: TranscriptEvent): void {
  if (event.messageId && !step.messageId) step.messageId = event.messageId;
  if (event.usage && !step.usage) step.usage = event.usage;
  if (step.startMs === undefined) {
    const startMs = parseMs(event.timestamp);
    if (startMs !== undefined) step.startMs = startMs;
  }
}
