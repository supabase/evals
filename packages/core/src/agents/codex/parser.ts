/**
 * Codex transcript parser — for `codex exec --json` (CLI ≥ ~0.130).
 *
 * The stream is newline-delimited thread/turn/item events:
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{…}}      // ignored — item.completed has everything
 *   {"type":"item.completed","item":{"id","type",…}}
 *   {"type":"turn.completed","usage":{…}}
 *
 * Observed `item.type`s: `agent_message` {text}, `reasoning` {text},
 * `command_execution` {command, aggregated_output, exit_code, status},
 * `file_change` {changes:[{path,kind}], status}. MCP / web-search items are
 * handled best-effort. Each tool item yields a paired tool_call + tool_result
 * (correlated by the item id) so the adapter can attach the output.
 *
 * `turn.completed.usage` covers the whole turn, not one message, so it's
 * attached to the turn's last assistant `message` event rather than emitting
 * its own event (see `parseTranscript`).
 *
 * NB: this is the `--json` event schema, NOT the `~/.codex/sessions` rollout
 * format (event_msg/response_item) that older parsers targeted.
 */

import { isRecord, parseJsonlRecords } from '../../json.js';
import type {
  ParsedTranscript,
  TokenUsage,
  TranscriptEvent,
} from '../../transcript/types.js';
import type { AgentTranscriptParser } from '../../parsers/types.js';
import {
  normalizeToolName,
  type AgentToolMap,
} from '../../parsers/shared/normalize.js';
import {
  extractArgs,
  extractLoadedSkillsFromText,
  type ArgFieldMap,
  type ExtractedArgs,
} from '../../parsers/shared/extract.js';

/**
 * Codex's tool names → canonical names. Codex names built-in tools by item type
 * (`command_execution`/`file_change`), not by a tool name. Owned here, not in shared.
 */
const CODEX_TOOLS: AgentToolMap = {
  tools: {
    command_execution: 'shell',
    exec_command: 'shell',
    local_shell_call: 'shell',
    file_change: 'file_write',
    apply_patch: 'file_write',
    web_search: 'web_search',
    mcp_tool_call: 'tool_use',
  },
};

/**
 * Codex's tool args → normalized fields. `command_execution` carries the shell
 * command in `command`; `file_change`'s path is nested under `changes[].path`,
 * so it's extracted directly (see `firstChangedPath`) rather than via this map.
 */
const CODEX_ARG_FIELDS: ArgFieldMap = {
  command: ['command'],
};

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Tri-state success from a Codex `status` field: completed → true, failed →
 * false, anything else (absent / in-progress / unrecognized) → undefined
 * (unknown). Mirrors how `command_execution` treats a missing exit code, so a
 * tool item with no status isn't silently scored as a success.
 */
function statusSuccess(status: unknown): boolean | undefined {
  if (status === 'completed') return true;
  if (status === 'failed') return false;
  return undefined;
}

/** Extract the first changed path from a `file_change` item. */
function firstChangedPath(item: Record<string, unknown>): string | undefined {
  if (!Array.isArray(item.changes)) return undefined;
  for (const change of item.changes) {
    if (isRecord(change) && typeof change.path === 'string') return change.path;
  }
  return undefined;
}

/**
 * Emit a paired tool_call + tool_result for one completed tool item. `args` stays
 * raw; `normalized` carries the agent-agnostic path/command/url views (set on the
 * tool_call so scorers read them without knowing Codex's item shapes).
 */
function toolCallPair(
  id: string,
  originalName: string,
  args: Record<string, unknown>,
  result: unknown,
  success: boolean | undefined,
  normalized: ExtractedArgs = {}
): TranscriptEvent[] {
  const name = normalizeToolName(originalName, CODEX_TOOLS);
  const tool: NonNullable<TranscriptEvent['tool']> = {
    name,
    originalName,
    id,
    args,
  };
  if (normalized.path) tool.path = normalized.path;
  if (normalized.command) tool.command = normalized.command;
  if (normalized.url) tool.url = normalized.url;
  const loadedSkills = loadedSkillsFromCodexCall(tool);
  if (loadedSkills.length > 0) tool.loadedSkills = loadedSkills;
  return [
    { type: 'tool_call', tool },
    { type: 'tool_result', tool: { name, originalName, id, result, success } },
  ];
}

/** Identifies Codex skill loads from normalized file paths or shell commands. */
function loadedSkillsFromCodexCall(
  tool: NonNullable<TranscriptEvent['tool']>
): string[] {
  if (tool.path) return extractLoadedSkillsFromText(tool.path);
  if (tool.command) return extractLoadedSkillsFromText(tool.command);
  return [];
}

function itemToEvents(item: Record<string, unknown>): TranscriptEvent[] {
  const id = str(item.id) ?? '';
  const itemType = str(item.type);

  switch (itemType) {
    case 'agent_message': {
      const text = str(item.text);
      return text
        ? [{ type: 'message', role: 'assistant', content: text }]
        : [];
    }
    case 'reasoning': {
      const text = str(item.text);
      return text ? [{ type: 'thinking', content: text }] : [];
    }
    case 'command_execution': {
      const command = str(item.command);
      const args = command ? { command } : {};
      const exitCode =
        typeof item.exit_code === 'number' ? item.exit_code : undefined;
      return toolCallPair(
        id,
        'command_execution',
        args,
        item.aggregated_output,
        exitCode === undefined ? undefined : exitCode === 0,
        extractArgs(args, CODEX_ARG_FIELDS)
      );
    }
    case 'file_change': {
      // Codex may touch several files in one item; `path` normalizes the first
      // (matching the single normalized `path` field), raw `changes` keeps all.
      const path = firstChangedPath(item);
      return toolCallPair(
        id,
        'file_change',
        { changes: item.changes },
        item.status,
        statusSuccess(item.status),
        { path }
      );
    }
    case 'mcp_tool_call': {
      // Shape not pinned across versions — be defensive about field names and
      // treat a missing status as unknown (not success).
      const tool =
        str(item.tool) ?? str(item.name) ?? str(item.server) ?? 'mcp_tool_call';
      return toolCallPair(
        id,
        tool,
        item,
        item.result ?? item.output,
        statusSuccess(item.status)
      );
    }
    case 'web_search': {
      return toolCallPair(
        id,
        'web_search',
        { query: item.query },
        undefined,
        statusSuccess(item.status)
      );
    }
    default:
      return [];
  }
}

/**
 * Token usage from a `turn.completed` record: raw Codex `usage` shape
 * (`input_tokens`, `output_tokens`, optionally `cached_input_tokens`).
 * Undefined when absent or unparseable.
 */
function extractTurnUsage(
  data: Record<string, unknown>
): TokenUsage | undefined {
  const usage = isRecord(data.usage) ? data.usage : undefined;
  if (!usage) return undefined;
  const inputTokens =
    typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
  const outputTokens =
    typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;
  const cacheReadTokens =
    typeof usage.cached_input_tokens === 'number'
      ? usage.cached_input_tokens
      : undefined;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens:
      inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined,
  };
}

function recordToEvents(data: Record<string, unknown>): TranscriptEvent[] {
  switch (data.type) {
    case 'item.completed':
      return isRecord(data.item) ? itemToEvents(data.item) : [];
    case 'turn.failed':
    case 'error': {
      const message =
        (isRecord(data.error) && str(data.error.message)) || str(data.message);
      return [{ type: 'error', content: message ?? JSON.stringify(data) }];
    }
    // thread.started / turn.started / item.started: no event.
    default:
      return [];
  }
}

export const codexParser: AgentTranscriptParser = {
  parseTranscript(raw: string): ParsedTranscript {
    const { records, errors } = parseJsonlRecords(raw);
    const events: TranscriptEvent[] = [];
    // `turn.completed.usage` covers the whole turn (every item since the last
    // turn boundary), not one message — attach it to the turn's LAST
    // message/tool_call event (the closest analogue to ai-sdk's per-step
    // usage). A turn is often tool-call-only (e.g. loading a skill produces no
    // text), so this must track the last transcript-emitting event of either
    // kind, not just the last assistant message.
    let lastTurnEventIndex = -1;
    for (const record of records) {
      try {
        if (record.type === 'turn.completed') {
          const usage = extractTurnUsage(record);
          if (usage && lastTurnEventIndex >= 0) {
            events[lastTurnEventIndex] = {
              ...events[lastTurnEventIndex],
              usage,
            };
          }
          continue;
        }
        for (const event of recordToEvents(record)) {
          events.push(event);
          if (event.type === 'message' || event.type === 'tool_call') {
            lastTurnEventIndex = events.length - 1;
          }
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    return { events, errors };
  },
};
