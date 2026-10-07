/**
 * Adapter from canonical `TranscriptEvent`s to the scorer-facing transcript
 * shapes (`TranscriptPart[]` + `ToolCallRecord[]`).
 *
 * The CLI agent harness parses a raw transcript into `TranscriptEvent`s, then
 * runs them through here so scorers, `serializeTranscript`, and judges see the
 * exact same surface they get from `aiSdkAgent`. Tool calls and their results
 * arrive as separate events; this pairs them by `tool.id`.
 */

import type { ToolCallRecord, TranscriptPart } from '../index.js';
import type { ToolCall, TranscriptEvent } from '../transcript/types.js';

export interface AdaptedTranscript {
  transcript: TranscriptPart[];
  toolCalls: ToolCallRecord[];
  /** Final assistant message text (the agent's closing report). */
  agentReport: string;
  /** Number of assistant turns — the cross-agent analogue of generateText steps. */
  steps: number;
}

interface ResolvedResult {
  result?: unknown;
  error?: string;
  ts?: number;
}

export function adaptTranscript(events: TranscriptEvent[]): AdaptedTranscript {
  // Index tool results by their correlation id so a tool_call can pick up the
  // output that arrives on a later line.
  const resultsById = new Map<string, ResolvedResult>();
  for (const event of events) {
    if (event.type !== 'tool_result' || !event.tool?.id) continue;
    resultsById.set(event.tool.id, {
      ...toResolved(event.tool.result, event.tool.success),
      ...timed(event.timestamp),
    });
  }

  const transcript: TranscriptPart[] = [];
  const toolCalls: ToolCallRecord[] = [];
  let agentReport = '';
  let steps = 0;

  for (const event of events) {
    if (event.type === 'message' && event.role) {
      const content = event.content?.trim() ?? '';
      // An empty message still marks a model request that emitted nothing.
      if (!content && !event.requestId) continue;
      transcript.push({
        type: 'message',
        role: event.role,
        content,
        ...timed(event.timestamp),
        ...(event.requestId ? { requestId: event.requestId } : {}),
        ...(event.usage ? { usage: event.usage } : {}),
      });
      if (event.role === 'assistant' && content) {
        agentReport = content;
        steps += 1;
      }
    } else if (event.type === 'tool_call' && event.tool) {
      const body = event.tool.args ?? {};
      const resolved = event.tool.id
        ? resultsById.get(event.tool.id)
        : undefined;
      // Parsers set `call` on tool_call events; fall back defensively.
      const call: ToolCall = event.tool.call ?? {
        kind: 'other',
        toolName: event.tool.originalName,
      };
      transcript.push({
        type: 'tool_call',
        name: call.toolName,
        input: body,
        output: resolved?.error === undefined ? resolved?.result : undefined,
        error: resolved?.error,
        ...timed(event.timestamp),
        ...(resolved?.ts ? { resultTs: resolved.ts } : {}),
        ...(event.tool.id ? { id: event.tool.id } : {}),
        ...(event.requestId ? { requestId: event.requestId } : {}),
        ...(event.usage ? { usage: event.usage } : {}),
      });
      toolCalls.push({
        tool: call,
        body,
        // Normalized views the parser extracted, for agent-agnostic scorers.
        name: event.tool.name,
        path: event.tool.path,
        command: event.tool.command,
        url: event.tool.url,
        cwd: event.tool.cwd,
        loadedSkills: event.tool.loadedSkills,
        result: resolved?.error === undefined ? resolved?.result : undefined,
        error: resolved?.error,
        ts: parseTs(event.timestamp),
        ...(resolved?.ts ? { resultTs: resolved.ts } : {}),
      });
    }
  }

  return { transcript, toolCalls, agentReport, steps };
}

function toResolved(
  result: unknown,
  success: boolean | undefined
): ResolvedResult {
  if (success === false) {
    return {
      error: typeof result === 'string' ? result : JSON.stringify(result),
    };
  }
  return { result };
}

function timed(timestamp: string | undefined): { ts?: number } {
  const ts = parseTs(timestamp);
  return ts ? { ts } : {};
}

function parseTs(timestamp: string | undefined): number {
  if (!timestamp) return 0;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? 0 : ms;
}
