/**
 * OpenCode transcript parser — for `opencode run --format json` (CLI ≥ 1.15).
 *
 * The stream is newline-delimited event records, each `{ type, timestamp,
 * sessionID, part }`:
 *   {"type":"step_start","part":{"type":"step-start"}}
 *   {"type":"text","part":{"type":"text","text":"…"}}
 *   {"type":"tool_use","part":{"type":"tool","tool":"bash","callID":"…",
 *      "state":{"status":"completed","input":{…},"output":"…",
 *               "metadata":{"exit":0}}}}
 *   {"type":"reasoning","part":{"type":"reasoning","text":"…"}}
 *   {"type":"error","error":{"message":"…"}}
 *   {"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{…}}}
 *
 * A `tool_use` record is self-contained (input + output + status), so it yields
 * a paired tool_call + tool_result correlated by `part.callID`. Step records
 * carry token/finish info and produce no transcript event (the runner reads the
 * terminal `step_finish` reason for the stop reason).
 *
 * Adapted from `@supabase/agent-evals` (packages/agent-eval/src/parsers).
 */

import { isRecord, parseJsonlRecords } from '../../json.js';
import type {
  ParsedTranscript,
  TranscriptEvent,
} from '../../transcript/types.js';
import type { AgentTranscriptParser } from '../../parsers/types.js';
import {
  normalizeToolName,
  type AgentToolMap,
} from '../../parsers/shared/normalize.js';
import {
  extractArgs,
  extractLoadedSkillFromText,
  type ArgFieldMap,
  type ExtractedArgs,
} from '../../parsers/shared/extract.js';

/**
 * opencode's tool names → canonical names. opencode uses lowercase built-in tool
 * names. Owned here, not in shared. MCP tools arrive under their server name and
 * fall through to `tool_use`.
 */
const OPENCODE_TOOLS: AgentToolMap = {
  caseInsensitive: true,
  tools: {
    read: 'file_read',
    write: 'file_write',
    edit: 'file_edit',
    multiedit: 'file_edit',
    patch: 'file_edit',
    apply_patch: 'file_edit',
    bash: 'shell',
    shell: 'shell',
    webfetch: 'web_fetch',
    websearch: 'web_search',
    codesearch: 'grep',
    glob: 'glob',
    grep: 'grep',
    list: 'list_dir',
    ls: 'list_dir',
    task: 'agent_task',
    todowrite: 'agent_task',
    skill: 'tool_use',
  },
};

/**
 * opencode tool args → normalized fields. `bash` carries the command in
 * `command`; file tools the path in `filePath` (or `path`); `webfetch` the URL
 * in `url`. The shared extractor reads whichever keys this map names.
 */
const OPENCODE_ARG_FIELDS: ArgFieldMap = {
  path: ['filePath', 'file_path', 'path'],
  command: ['command'],
  url: ['url'],
};

/** Epoch-ms (or pass-through ISO) → ISO string. */
function toISO(value: unknown): string | undefined {
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') return value;
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Whether a completed tool call succeeded: shell keys off its exit code. */
function toolSuccess(
  canonical: string,
  status: string | undefined,
  metadata: Record<string, unknown> | undefined
): boolean | undefined {
  if (status === undefined) return undefined;
  if (status !== 'completed') return false;
  if (canonical === 'shell') {
    const exit = metadata?.exit;
    return typeof exit === 'number' ? exit === 0 : true;
  }
  return true;
}

function partToEvents(
  type: string,
  part: Record<string, unknown>,
  timestamp: string | undefined,
  raw: unknown
): TranscriptEvent[] {
  switch (type) {
    case 'text': {
      const text = str(part.text);
      return text
        ? [
            {
              timestamp,
              type: 'message',
              role: 'assistant',
              content: text,
              raw,
            },
          ]
        : [];
    }
    case 'reasoning': {
      const text = str(part.text);
      return text ? [{ timestamp, type: 'thinking', content: text, raw }] : [];
    }
    case 'tool_use': {
      const originalName = str(part.tool) ?? 'unknown';
      const id = str(part.callID);
      const state = isRecord(part.state) ? part.state : {};
      const args = isRecord(state.input) ? state.input : {};
      const status = str(state.status);
      const metadata = isRecord(state.metadata) ? state.metadata : undefined;
      // The builtin tool set is fully enumerated in OPENCODE_TOOLS, so any
      // unmapped name is an MCP/custom tool (`<server>_<tool>`, which the
      // shared `mcp__` fallback doesn't recognize).
      const mapped = normalizeToolName(originalName, OPENCODE_TOOLS);
      const name = mapped === 'unknown' ? 'tool_use' : mapped;
      const normalized: ExtractedArgs = extractArgs(args, OPENCODE_ARG_FIELDS);

      const tool: NonNullable<TranscriptEvent['tool']> = {
        name,
        originalName,
        id,
        args,
      };
      if (normalized.path) tool.path = normalized.path;
      if (normalized.command) tool.command = normalized.command;
      if (normalized.url) tool.url = normalized.url;
      tool.loadedSkill = loadedSkillFromOpencodeCall(tool);

      const events: TranscriptEvent[] = [
        { timestamp, type: 'tool_call', tool, raw },
      ];
      // The result is in the same record; emit it only once the call completed.
      if (status && status !== 'running' && status !== 'pending') {
        events.push({
          timestamp,
          type: 'tool_result',
          tool: {
            name,
            originalName,
            id,
            result:
              state.output ?? (isRecord(state.error) ? state.error : undefined),
            success: toolSuccess(name, status, metadata),
          },
          raw: state,
        });
      }
      return events;
    }
    default:
      return [];
  }
}

/**
 * Identifies opencode skill loads. opencode's native `skill` tool carries the
 * skill name in its args; skills read manually surface as `skills/<name>/
 * SKILL.md` in a file path or shell command.
 */
function loadedSkillFromOpencodeCall(
  tool: NonNullable<TranscriptEvent['tool']>
): string | undefined {
  if (tool.originalName.toLowerCase() === 'skill') {
    const name = tool.args?.name ?? tool.args?.skill;
    if (typeof name === 'string') return name;
  }
  if (tool.path) return extractLoadedSkillFromText(tool.path);
  if (tool.command) return extractLoadedSkillFromText(tool.command);
  return undefined;
}

function recordToEvents(data: Record<string, unknown>): TranscriptEvent[] {
  const type = str(data.type);
  if (!type) return [];
  const timestamp = toISO(data.timestamp);

  if (type === 'error') {
    const error = isRecord(data.error) ? data.error : undefined;
    const message =
      str(error?.message) ??
      str(data.message) ??
      JSON.stringify(data.error ?? data);
    return [{ timestamp, type: 'error', content: message, raw: data }];
  }
  // step_start / step_finish carry no transcript content (tokens + finish reason
  // only; the runner reads the terminal step_finish reason for the stop reason).
  if (type === 'step_start' || type === 'step_finish') return [];

  const part = isRecord(data.part) ? data.part : undefined;
  if (!part) return [];
  return partToEvents(type, part, timestamp, data);
}

export const opencodeParser: AgentTranscriptParser = {
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
