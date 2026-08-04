/**
 * Cursor transcript parser.
 *
 * Parses the stream-json NDJSON that `cursor-agent --print --output-format=stream-json`
 * writes to stdout (see ../runner.ts). Event shapes follow Cursor's CLI docs and
 * Harbor's cursor-cli trajectory mapper; we emit supabase canonical
 * `TranscriptEvent`s (not ATIF).
 */

import type {
  ParsedTranscript,
  TranscriptEvent,
} from '../../transcript/types.js';
import type { AgentTranscriptParser } from '../../parsers/types.js';
import { isRecord, parseJsonlRecords } from '../../json.js';
import {
  normalizeToolName,
  type AgentToolMap,
} from '../../parsers/shared/normalize.js';
import {
  extractArgs,
  extractLoadedSkillsFromText,
  type ArgFieldMap,
} from '../../parsers/shared/extract.js';

/** Cursor stream-json tool keys → canonical names. */
const CURSOR_TOOLS: AgentToolMap = {
  tools: {
    readToolCall: 'file_read',
    writeToolCall: 'file_write',
    shellToolCall: 'shell',
    // Live MCP probe (M0)
    mcpToolCall: 'tool_use',
    getMcpToolsToolCall: 'tool_use',
    // Harbor / older shapes
    write_file: 'file_write',
    mark_done: 'unknown',
  },
};

const CURSOR_ARG_FIELDS: ArgFieldMap = {
  path: ['path', 'file_path'],
  command: ['command'],
  url: ['url'],
};

/** Non-tool keys that appear beside tool payloads on completed tool_call events. */
const TOOL_CALL_META = new Set([
  'hookAdditionalContexts',
  'toolCallId',
  'startedAtMs',
  'completedAtMs',
]);

function timestampFromRecord(
  data: Record<string, unknown>
): string | undefined {
  if (typeof data.timestamp === 'string') return data.timestamp;
  if (typeof data.timestamp_ms === 'number') {
    return new Date(data.timestamp_ms).toISOString();
  }
  return undefined;
}

function messageText(data: Record<string, unknown>): string | undefined {
  const message = data.message;
  if (!isRecord(message)) return undefined;
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const texts = message.content
    .filter(
      (b): b is Record<string, unknown> => isRecord(b) && b.type === 'text'
    )
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

function enrich(event: TranscriptEvent): TranscriptEvent {
  if (event.type !== 'tool_call' || !event.tool) return event;
  const { path, command, url } = extractArgs(
    event.tool.args ?? {},
    CURSOR_ARG_FIELDS
  );
  if (path) event.tool.path = path;
  if (command) event.tool.command = command;
  if (url) event.tool.url = url;
  const loaded: string[] = [];
  if (path) loaded.push(...extractLoadedSkillsFromText(path));
  if (command) loaded.push(...extractLoadedSkillsFromText(command));
  if (loaded.length > 0) event.tool.loadedSkills = loaded;
  return event;
}

function originalNameFor(
  toolKey: string,
  payload: Record<string, unknown>
): string {
  if (toolKey === 'mcpToolCall') {
    const args = isRecord(payload.args) ? payload.args : {};
    if (typeof args.toolName === 'string') return args.toolName;
    if (typeof args.name === 'string') return args.name;
  }
  return toolKey;
}

function toolArgs(payload: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(payload.args)) return payload.args;
  return {};
}

/**
 * Normalize Cursor's varied result payloads into a value + success flag.
 * Built-ins often use `{ success: {...} }` / `{ error: {...} }`; MCP may nest
 * `{ success: { content, isError } }`.
 */
function normalizeToolResult(result: unknown): {
  result: unknown;
  success?: boolean;
} {
  if (result === undefined) return { result: undefined, success: true };
  if (!isRecord(result)) return { result, success: true };

  if ('success' in result) {
    const successBody = result.success;
    if (isRecord(successBody) && typeof successBody.isError === 'boolean') {
      return { result: successBody, success: !successBody.isError };
    }
    return { result: successBody, success: true };
  }
  if ('error' in result) {
    return { result: result.error, success: false };
  }
  if (typeof result.isError === 'boolean') {
    return { result, success: !result.isError };
  }
  return { result, success: true };
}

function toolPayloads(
  toolCall: Record<string, unknown>
): Array<{ key: string; payload: Record<string, unknown> }> {
  const out: Array<{ key: string; payload: Record<string, unknown> }> = [];
  for (const [key, value] of Object.entries(toolCall)) {
    if (TOOL_CALL_META.has(key)) continue;
    if (!isRecord(value)) continue;
    if (!('args' in value) && !('result' in value)) continue;
    out.push({ key, payload: value });
  }
  return out;
}

function completedToolEvents(data: Record<string, unknown>): TranscriptEvent[] {
  const toolCall = data.tool_call;
  if (!isRecord(toolCall)) return [];

  const timestamp = timestampFromRecord(data);
  const callId = typeof data.call_id === 'string' ? data.call_id : undefined;
  const events: TranscriptEvent[] = [];

  for (const { key, payload } of toolPayloads(toolCall)) {
    const originalName = originalNameFor(key, payload);
    const args = toolArgs(payload);
    const id =
      callId ??
      (typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined);

    events.push(
      enrich({
        timestamp,
        type: 'tool_call',
        tool: {
          name: normalizeToolName(key, CURSOR_TOOLS),
          originalName,
          id,
          args,
        },
        raw: data,
      })
    );

    if ('result' in payload) {
      const normalized = normalizeToolResult(payload.result);
      events.push({
        timestamp,
        type: 'tool_result',
        tool: {
          name: normalizeToolName(key, CURSOR_TOOLS),
          originalName,
          id,
          result: normalized.result,
          success: normalized.success,
        },
        raw: data,
      });
    }
  }
  return events;
}

export const cursorParser: AgentTranscriptParser = {
  parseTranscript(raw: string): ParsedTranscript {
    const { records, errors } = parseJsonlRecords(raw);
    const events: TranscriptEvent[] = [];
    let thinkingBuf: string[] = [];
    let lastAssistantText: string | undefined;

    const flushThinking = (): void => {
      const content = thinkingBuf.join('');
      thinkingBuf = [];
      if (!content.trim()) return;
      events.push({ type: 'thinking', content });
    };

    for (const record of records) {
      try {
        const type = record.type;

        if (type === 'thinking') {
          if (record.subtype === 'delta' && typeof record.text === 'string') {
            thinkingBuf.push(record.text);
          } else if (record.subtype === 'completed') {
            flushThinking();
          }
          continue;
        }

        // Any non-thinking event ends the current thinking span.
        flushThinking();

        if (type === 'system' || type === 'interaction_query') {
          continue;
        }

        if (type === 'user') {
          const content = messageText(record);
          if (content) {
            events.push({
              timestamp: timestampFromRecord(record),
              type: 'message',
              role: 'user',
              content,
              raw: record,
            });
          }
          continue;
        }

        if (type === 'assistant') {
          const content = messageText(record);
          if (content) {
            events.push({
              timestamp: timestampFromRecord(record),
              type: 'message',
              role: 'assistant',
              content,
              raw: record,
            });
            lastAssistantText = content;
          }
          continue;
        }

        if (type === 'tool_call') {
          if (record.subtype === 'started') continue;
          if (record.subtype === 'completed') {
            events.push(...completedToolEvents(record));
          }
          continue;
        }

        if (type === 'result') {
          const resultText =
            typeof record.result === 'string' ? record.result : undefined;
          if (record.is_error === true) {
            events.push({
              timestamp: timestampFromRecord(record),
              type: 'error',
              content: resultText ?? 'cursor agent error',
              raw: record,
            });
          } else if (resultText && resultText !== lastAssistantText) {
            events.push({
              timestamp: timestampFromRecord(record),
              type: 'message',
              role: 'assistant',
              content: resultText,
              raw: record,
            });
            lastAssistantText = resultText;
          }
          continue;
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    flushThinking();
    return { events, errors };
  },
};
