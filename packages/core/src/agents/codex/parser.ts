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
 * NB: this is the `--json` event schema, NOT the `~/.codex/sessions` rollout
 * format (event_msg/response_item) that older parsers targeted.
 */

import { isRecord, parseJsonlRecords } from '../../json.js';
import type {
  ParsedTranscript,
  ToolCall,
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
  normalized: ExtractedArgs = {},
  // MCP items pass an explicit call identity; native items default to `other`
  // with the item-type name as the bare tool name.
  call: ToolCall = { kind: 'other', toolName: originalName }
): TranscriptEvent[] {
  const name = normalizeToolName(originalName, CODEX_TOOLS);
  const tool: NonNullable<TranscriptEvent['tool']> = {
    name,
    originalName,
    call,
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
      // treat a missing status as unknown (not success). `item.tool` is the
      // bare tool name; `item.server` names the MCP server when present.
      const bare = str(item.tool) ?? str(item.name) ?? 'mcp_tool_call';
      const server = str(item.server);
      return toolCallPair(
        id,
        bare,
        item,
        item.result ?? item.output,
        statusSuccess(item.status),
        {},
        server
          ? { kind: 'mcp', server, toolName: bare }
          : { kind: 'other', toolName: bare }
      );
    }
    case 'web_search': {
      // `action` says what the hosted tool actually did (`search`,
      // `open_page`, `find_in_page`). `query` is only its display rendering,
      // which collapses a url open and a search for that url into the same
      // string, so keep the action itself.
      return toolCallPair(
        id,
        'web_search',
        { query: item.query, action: item.action },
        undefined,
        statusSuccess(item.status)
      );
    }
    default:
      return [];
  }
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
    // thread.started / turn.started / item.started / turn.completed: no event.
    default:
      return [];
  }
}

export const codexParser: AgentTranscriptParser = {
  parseTranscript(raw: string): ParsedTranscript {
    const { records, errors } = parseJsonlRecords(raw);
    const events: TranscriptEvent[] = [];
    for (const record of records) {
      try {
        events.push(...recordToEvents(record));
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    return { events, errors };
  },
};
