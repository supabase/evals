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
  RequestUsage,
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

/**
 * Rollout names for the stdout items that `itemToEvents` makes tool calls from.
 * Counting any other rollout item would shift the pairing.
 * https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/items.rs#L45-L77
 */
const ROLLOUT_TOOL_ITEMS = new Set([
  'CommandExecution',
  'FileChange',
  'McpToolCall',
  'WebSearch',
]);

/**
 * Fills in event times, model requests, and per-request usage from the session
 * rollout, which the `--json` stream lacks. The two streams list tool items and
 * assistant messages in the same order but under different ids, so they're
 * paired by position. Tool pairs must also agree on the command or MCP tool,
 * and any count or content mismatch leaves that kind of event untouched.
 * A request no event came from, like a compaction call, gets an empty message.
 *
 *   rollout: reasoning → message → function_call(c1) → token_usage_record(r1)
 *            → function_call_output(c1)
 *   events:  message → tool_call → tool_result, each tagged requestId r1
 */
export function enrichFromRollout(
  events: TranscriptEvent[],
  rollout: string
): void {
  interface Request {
    id?: string;
    usage?: RequestUsage;
  }
  const callStarts = new Map<string, { at?: string; request: Request }>();
  const callEnds = new Map<string, string | undefined>();
  const messages: { at?: string; request: Request }[] = [];
  const toolItems: Record<string, unknown>[] = [];
  const requests: { at?: string; request: Request }[] = [];
  let open: Request | undefined;

  for (const record of parseJsonlRecords(rollout).records) {
    const at = str(record.timestamp);
    const payload = isRecord(record.payload) ? record.payload : {};
    if (record.type === 'token_usage_record') {
      const request = open ?? {};
      request.id = str(payload.response_id);
      request.usage = rolloutUsage(payload.usage);
      requests.push({ at, request });
      open = undefined;
    } else if (record.type === 'response_item') {
      const callId = str(payload.call_id);
      if (
        payload.type === 'function_call_output' ||
        payload.type === 'custom_tool_call_output'
      ) {
        if (callId) callEnds.set(callId, at);
        continue;
      }
      if (payload.type === 'message' && payload.role !== 'assistant') continue;
      open ??= {};
      if (payload.type === 'message') messages.push({ at, request: open });
      if (callId) callStarts.set(callId, { at, request: open });
    } else if (
      record.type === 'event_msg' &&
      payload.type === 'item_completed' &&
      isRecord(payload.item)
    ) {
      const { type, id } = payload.item;
      if (typeof id === 'string' && ROLLOUT_TOOL_ITEMS.has(String(type))) {
        toolItems.push(payload.item);
      }
    }
  }

  const tag = (event: TranscriptEvent, request: Request) => {
    if (request.id) event.requestId = request.id;
    if (request.usage) event.usage = request.usage;
  };
  const assistant = events.filter(
    (e) => e.type === 'message' && e.role === 'assistant'
  );
  if (assistant.length === messages.length) {
    assistant.forEach((event, i) => {
      event.timestamp = messages[i].at ?? event.timestamp;
      tag(event, messages[i].request);
    });
  }
  const calls = events.filter((e) => e.type === 'tool_call');
  if (
    calls.length !== toolItems.length ||
    calls.some((event, i) => !sameCall(event, toolItems[i]))
  ) {
    return;
  }
  const callIdByItem = new Map<string, string>();
  calls.forEach((event, i) => {
    const itemId = String(toolItems[i].id);
    const start = callStarts.get(itemId);
    if (event.tool?.id) callIdByItem.set(event.tool.id, itemId);
    if (!start) return;
    event.timestamp = start.at ?? event.timestamp;
    tag(event, start.request);
  });
  for (const event of events) {
    if (event.type !== 'tool_result' || !event.tool?.id) continue;
    const callId = callIdByItem.get(event.tool.id);
    const end = callId ? callEnds.get(callId) : undefined;
    if (end) event.timestamp = end;
  }
  const tagged = new Set(events.map((e) => e.requestId));
  for (const { at, request } of requests) {
    if (!request.id || tagged.has(request.id)) continue;
    const silent: TranscriptEvent = {
      type: 'message',
      role: 'assistant',
      content: '',
      timestamp: at,
    };
    tag(silent, request);
    // Rollout timestamps share one ISO format, so they sort as strings.
    const next = events.findIndex((e) => at && e.timestamp && e.timestamp > at);
    events.splice(next === -1 ? events.length : next, 0, silent);
  }
}

/**
 * A command must split into exactly the rollout's argv. Stdout redacts secrets
 * the rollout keeps, so `[REDACTED_SECRET]` matches any text in its word.
 * https://github.com/openai/codex/blob/5fa5aaf0fffd6593ca60ed974af3e87e29f3be28/codex-rs/secrets/src/sanitizer.rs#L15-L22
 *
 *   stdout:  [bash, -lc, "login --password [REDACTED_SECRET]"]
 *   rollout: [bash, -lc, "login --password hunter2"]   → same call
 */
function sameCall(event: TranscriptEvent, item: Record<string, unknown>) {
  if (item.type === 'CommandExecution' && Array.isArray(item.command)) {
    const words = event.tool?.command
      ? splitShellWords(event.tool.command)
      : undefined;
    const argv = item.command.map(String);
    return (
      !!words &&
      words.length === argv.length &&
      words.every((word, i) => sameWord(word, argv[i]))
    );
  }
  if (item.type === 'McpToolCall') {
    return event.tool?.call?.toolName === item.tool;
  }
  return true;
}

const REDACTED = '[REDACTED_SECRET]';

function sameWord(word: string, raw: string): boolean {
  if (!word.includes(REDACTED)) return word === raw;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = word.split(REDACTED).map(escape).join('[\\s\\S]*');
  return new RegExp(`^${pattern}$`).test(raw);
}

/**
 * POSIX shell word splitting (quotes and backslashes, no expansion), enough to
 * recover the argv Codex shell-joined into a `command_execution` command.
 * Undefined on an unterminated quote or trailing backslash.
 */
function splitShellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return undefined;
      word = (word ?? '') + command.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      let quoted = '';
      i += 1;
      for (; i < command.length && command[i] !== '"'; i += 1) {
        const next = command[i + 1];
        if (
          command[i] === '\\' &&
          next !== undefined &&
          '$`"\\\n'.includes(next)
        ) {
          i += 1;
          if (next === '\n') continue;
        }
        quoted += command[i];
      }
      if (i >= command.length) return undefined;
      word = (word ?? '') + quoted;
    } else if (ch === '\\') {
      i += 1;
      if (i >= command.length) return undefined;
      if (command[i] !== '\n') word = (word ?? '') + command[i];
    } else if (/\s/.test(ch)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else {
      word = (word ?? '') + ch;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** Codex's `input_tokens` already includes both cache buckets. */
function rolloutUsage(usage: unknown): RequestUsage | undefined {
  if (!isRecord(usage)) return undefined;
  return {
    inputTokens: Number(usage.input_tokens) || 0,
    cacheReadInputTokens: Number(usage.cached_input_tokens) || 0,
    cacheWriteInputTokens: Number(usage.cache_write_input_tokens) || 0,
    outputTokens: Number(usage.output_tokens) || 0,
  };
}
