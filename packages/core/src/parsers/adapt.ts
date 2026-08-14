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
import type { TranscriptEvent } from '../transcript/types.js';

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
}

export function adaptTranscript(events: TranscriptEvent[]): AdaptedTranscript {
  // Index tool results by their correlation id so a tool_call can pick up the
  // output that arrives on a later line.
  const resultsById = new Map<string, ResolvedResult>();
  for (const event of events) {
    if (event.type !== 'tool_result' || !event.tool?.id) continue;
    resultsById.set(
      event.tool.id,
      toResolved(event.tool.result, event.tool.success)
    );
  }

  const transcript: TranscriptPart[] = [];
  const toolCalls: ToolCallRecord[] = [];
  let agentReport = '';
  let steps = 0;

  for (const event of events) {
    // Subagent-attributed events are kept in the transcript (tagged) for
    // visibility, but never shape the main-thread surface: the final report,
    // the step count, and the scorer-facing tool-call records stay exactly
    // what the top-level agent did.
    if (event.type === 'message' && event.role && event.content) {
      const content = event.content.trim();
      if (!content) continue;
      transcript.push({
        type: 'message',
        role: event.role,
        content,
        ...(event.subagent ? { subagent: event.subagent } : {}),
      });
      if (event.role === 'assistant' && !event.subagent) {
        agentReport = content;
        steps += 1;
      }
    } else if (event.type === 'thinking' && event.content) {
      const content = event.content.trim();
      if (!content) continue;
      transcript.push({
        type: 'thinking',
        content,
        ...(event.subagent ? { subagent: event.subagent } : {}),
      });
    } else if (event.type === 'tool_call' && event.tool) {
      const body = event.tool.args ?? {};
      const resolved = event.tool.id
        ? resultsById.get(event.tool.id)
        : undefined;
      transcript.push({
        type: 'tool_call',
        name: event.tool.originalName,
        input: body,
        output: resolved?.error === undefined ? resolved?.result : undefined,
        error: resolved?.error,
        ...(event.subagent ? { subagent: event.subagent } : {}),
      });
      if (event.subagent) continue;
      toolCalls.push({
        endpoint: event.tool.originalName,
        body,
        // Normalized views the parser extracted, for agent-agnostic scorers.
        name: event.tool.name,
        path: event.tool.path,
        command: event.tool.command,
        url: event.tool.url,
        loadedSkills: event.tool.loadedSkills,
        result: resolved?.error === undefined ? resolved?.result : undefined,
        error: resolved?.error,
        ts: parseTs(event.timestamp),
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

function parseTs(timestamp: string | undefined): number {
  if (!timestamp) return 0;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? 0 : ms;
}
