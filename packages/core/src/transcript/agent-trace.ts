/**
 * Structured, agent-agnostic transcript: turns (one per model API call) with
 * their tool executions nested, results paired at assembly time, and subagent
 * sidechains attached under the tool call that spawned them.
 *
 * Assembled from the same canonical `TranscriptEvent[]` the flat scorer
 * surface (`adaptTranscript`) consumes, so the two views can never disagree
 * about what happened; this one just stops throwing the structure away.
 * Turn grouping uses `event.turnKey` when the parser stamped one (Claude
 * Code: one assistant line = one API message; ai-sdk builds turns directly
 * from steps) and otherwise falls back to a closure rule: thinking and tool
 * calls accumulate into the open turn, an assistant message closes it
 * (Codex's item stream).
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
  children?: AgentTurn[];
}

export interface AgentTurn {
  index: number;
  /** Provider message id of the API call, when exposed. */
  messageId?: string;
  /** Per-turn token usage, when the transcript carries it. */
  usage?: AgentUsage;
  startMs?: number;
  thinking?: string;
  /** Assistant prose (absent on pure-tool turns). */
  text?: string;
  toolCalls: ToolExecution[];
}

/** A user/system message arriving between turns (e.g. an injected skill body). */
export interface TraceInterjection {
  /** Index of the last turn opened before this message; -1 = before any turn. */
  afterTurnIndex: number;
  role: "user" | "system";
  content: string;
}

export interface AgentTrace {
  turns: AgentTurn[];
  interjections: TraceInterjection[];
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
  const interjections: TraceInterjection[] = [];
  const errors: string[] = [];
  const executionsById = new Map<string, ToolExecution>();
  const turnsByKey = new Map<string, AgentTurn>();
  // Closure-rule state for events without a turnKey: an assistant message
  // marks the open turn closed, so the next event starts a fresh one.
  let openTurn: AgentTurn | undefined;
  let openTurnClosed = false;

  const turnFor = (event: TranscriptEvent): AgentTurn => {
    if (event.turnKey) {
      const existing = turnsByKey.get(event.turnKey);
      if (existing) return existing;
      const turn = newTurn(event);
      turnsByKey.set(event.turnKey, turn);
      return turn;
    }
    if (!openTurn || openTurnClosed) {
      openTurn = newTurn(event);
      openTurnClosed = false;
    }
    return openTurn;
  };

  const newTurn = (event: TranscriptEvent): AgentTurn => {
    const turn: AgentTurn = { index: turns.length, toolCalls: [] };
    const startMs = parseMs(event.timestamp);
    if (startMs !== undefined) turn.startMs = startMs;
    turns.push(turn);
    return turn;
  };

  for (const event of events) {
    if (event.parentToolUseId) continue;

    if (event.type === "error") {
      if (event.content) errors.push(event.content);
      continue;
    }

    if (event.type === "message" && event.role && event.role !== "assistant") {
      const content = event.content?.trim();
      if (content) {
        interjections.push({
          afterTurnIndex: turns.length - 1,
          role: event.role,
          content,
        });
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
      const turn = turnFor(event);
      const content = event.content?.trim();
      if (content) {
        turn.text = turn.text ? `${turn.text}\n${content}` : content;
      }
      annotate(turn, event);
      if (!event.turnKey) openTurnClosed = true;
      continue;
    }

    if (event.type === "thinking") {
      const turn = turnFor(event);
      const content = event.content?.trim();
      if (content) {
        turn.thinking = turn.thinking ? `${turn.thinking}\n${content}` : content;
      }
      annotate(turn, event);
      continue;
    }

    if (event.type === "tool_call" && event.tool) {
      const turn = turnFor(event);
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
      turn.toolCalls.push(execution);
      if (execution.id) executionsById.set(execution.id, execution);
      annotate(turn, event);
    }
  }

  // Attach sidechains to their spawning tool call; groups whose parent call
  // never appeared (truncated transcript) surface as an error note instead
  // of vanishing.
  for (const [parentId, group] of sidechains) {
    const parent = executionsById.get(parentId);
    const subTrace = assembleAgentTrace(group);
    errors.push(...subTrace.errors);
    if (parent) {
      parent.children = subTrace.turns;
    } else if (subTrace.turns.length > 0) {
      errors.push(
        `orphaned subagent transcript (parent tool_use ${parentId} not found)`,
      );
    }
  }

  return { turns, interjections, errors };
}

/** Fold an event's per-call identifiers/usage onto its turn. */
function annotate(turn: AgentTurn, event: TranscriptEvent): void {
  if (event.messageId && !turn.messageId) turn.messageId = event.messageId;
  if (event.usage && !turn.usage) turn.usage = event.usage;
  if (turn.startMs === undefined) {
    const startMs = parseMs(event.timestamp);
    if (startMs !== undefined) turn.startMs = startMs;
  }
}
