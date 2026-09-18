/**
 * Grok CLI transcript parser — for `grok -p --output-format streaming-json`.
 *
 * The stream is newline-delimited events, each with a `type`:
 *   {"type":"available_commands","tools":[…],"commands":[…]}   // inventory, ignored
 *   {"type":"thought","data":"…"}                              // reasoning delta
 *   {"type":"text","data":"…"}                                 // response delta
 *   {"type":"usage","usage":{…}}                               // per-step usage
 *   {"type":"tool_call","toolCallId":"…","toolName":"…","rawInput":{…}}
 *   {"type":"tool_call_update","toolCallId":"…","status":"completed","rawOutput":{…}}
 *   {"type":"end","stopReason":"end_turn","num_turns":N,"modelUsage":{…}}
 *
 * Grok is different from the other agents in two ways.
 *
 * First, Grok sends a `text` event and a `thought` event for each token, and not
 * for each message. This parser joins the adjacent events of one type into one
 * event.
 *
 * Second, Grok does not show the MCP tools directly. It uses two steps:
 * `search_tool` finds a tool in the catalog, then `use_tool` starts the tool. In
 * the `use_tool` event, `rawInput.tool_name` has the format `<server>__<tool>`.
 * Thus an MCP call looks like a `use_tool` call. This parser divides the name
 * into its two parts. Then the scorers get the same `{kind:'mcp', server,
 * toolName}` data that Claude Code and Codex give. The result of the tool also
 * has this data, in a `rawOutput` field with the format `{type:'MCP',
 * server_name, tool_name}`.
 *
 * One call sends more than one `tool_call_update` event. Only the last event
 * contains the output. Thus this parser keeps the data of the call, and sends
 * one `tool_result` event at the end.
 *
 * xAI runs web search on its servers and returns a synthesized answer with a
 * `citations` array of the urls it examined.
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
} from '../../parsers/shared/extract.js';

/**
 * The tool names of Grok, and the equivalent standard names. These names come
 * from true transcripts, because the documentation of the CLI is not correct.
 * For example, the shell tool has the name `run_terminal_command`, but the
 * documentation shows `run_terminal_cmd`.
 */
const GROK_TOOLS: AgentToolMap = {
  tools: {
    read_file: 'file_read',
    write: 'file_write',
    create_file: 'file_write',
    search_replace: 'file_edit',
    edit_file: 'file_edit',
    apply_patch: 'file_edit',
    run_terminal_command: 'shell',
    list_dir: 'list_dir',
    grep: 'grep',
    glob: 'glob',
    file_search: 'glob',
    web_search: 'web_search',
    web_fetch: 'web_fetch',
    task: 'agent_task',
    // The tool that makes a list of tasks. Claude Code has the `TodoWrite` tool
    // and opencode has the `todowrite` tool. All three become `agent_task`.
    todo_write: 'agent_task',
    // These tools control a command that operates in the background.
    get_command_or_subagent_output: 'shell',
    kill_command_or_subagent: 'shell',
    // This key comes from `rawInput.variant`. Refer to `emittedToolName`.
    WebSearch: 'web_search',
    // These two tools find an MCP tool and then start it.
    search_tool: 'tool_use',
    use_tool: 'tool_use',
  },
};

/** The argument names of Grok, and the equivalent standard field names. */
const GROK_ARG_FIELDS: ArgFieldMap = {
  path: ['file_path', 'target_file', 'path', 'directory_path'],
  command: ['command'],
  url: ['url'],
};

/** The characters between the MCP server name and the tool name. */
const MCP_NAME_SEPARATOR = '__';

/**
 * Find the tool id to compare with {@link GROK_TOOLS}.
 *
 * The id is usually in `toolName`. But some tools put a title in that field. For
 * example, a web search has `toolName: 'Web search:'` and `rawInput: {variant:
 * 'WebSearch', backend: true}`. A title is not a good key, because the spaces
 * and the punctuation marks can change. Thus if `toolName` is not a known id,
 * and `rawInput` contains a `variant` field, use the `variant` field.
 */
function emittedToolName(
  toolName: string,
  rawInput: Record<string, unknown>
): string {
  if (toolName in GROK_TOOLS.tools) return toolName;
  return str(rawInput.variant) ?? toolName;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Examine the status of an update. The `completed` status and the `failed`
 * status end a call. The `in_progress` status and a null status do not end a
 * call, and they contain no output.
 */
function statusSuccess(status: unknown): boolean | undefined {
  if (status === 'completed') return true;
  if (status === 'failed' || status === 'error') return false;
  return undefined;
}

/**
 * Divide a `use_tool` call into the MCP server name and the tool name. The
 * `tool_name` field has the format `<server>__<tool>`. If the field has a
 * different format, the call stays `other`, because the server has no name.
 */
function unwrapUseTool(
  rawInput: Record<string, unknown>
):
  | { call: ToolCall; originalName: string; args: Record<string, unknown> }
  | undefined {
  const qualified = str(rawInput.tool_name);
  if (!qualified) return undefined;
  const separator = qualified.indexOf(MCP_NAME_SEPARATOR);
  const args = isRecord(rawInput.tool_input) ? rawInput.tool_input : {};
  if (separator <= 0) {
    return {
      call: { kind: 'other', toolName: qualified },
      originalName: qualified,
      args,
    };
  }
  const server = qualified.slice(0, separator);
  const toolName = qualified.slice(separator + MCP_NAME_SEPARATOR.length);
  return {
    call: { kind: 'mcp', server, toolName },
    originalName: toolName,
    args,
  };
}

/**
 * Find the standard name of a call. After this parser divides an MCP name, the
 * name has no prefix. But `normalizeToolName` needs the `mcp__server__tool`
 * prefix of Claude Code. Thus all MCP tools get the `tool_use` name here, and
 * they do not get the `unknown` name.
 */
function canonicalName(originalName: string, call: ToolCall) {
  return call.kind === 'mcp'
    ? 'tool_use'
    : normalizeToolName(originalName, GROK_TOOLS);
}

/** The data of one tool call, from its `tool_call` and `tool_call_update` events. */
interface PendingCall {
  id: string;
  originalName: string;
  call: ToolCall;
  args: Record<string, unknown>;
  result?: unknown;
  success?: boolean;
}

/**
 * Find the data for a `tool_result` event. Grok puts the output in a `rawOutput`
 * field, and each tool uses a different structure. This function reads the known
 * structures. For an unknown structure, it gives the full object.
 */
function resultPayload(rawOutput: unknown): unknown {
  if (!isRecord(rawOutput)) return rawOutput;
  switch (rawOutput.type) {
    case 'MCP':
      // {type:'MCP', tool_name, server_name, output:{OkayOutput:'…'}}
      return isRecord(rawOutput.output) &&
        rawOutput.output.OkayOutput !== undefined
        ? rawOutput.output.OkayOutput
        : rawOutput.output;
    case 'Bash':
      // `output` is a byte array; `output_for_prompt` is the text the model saw.
      return rawOutput.output_for_prompt ?? rawOutput;
    case 'ReadFile':
      return isRecord(rawOutput.FileContent)
        ? rawOutput.FileContent.content
        : rawOutput;
    default:
      return rawOutput;
  }
}

/** Bash gives an exit code. It is more accurate than the status of the update. */
function bashSuccess(rawOutput: unknown): boolean | undefined {
  if (!isRecord(rawOutput) || rawOutput.type !== 'Bash') return undefined;
  if (rawOutput.timed_out === true) return false;
  return typeof rawOutput.exit_code === 'number'
    ? rawOutput.exit_code === 0
    : undefined;
}

/** The agent loads a skill when it reads a SKILL.md file with a tool or the shell. */
function loadedSkills(
  args: Record<string, unknown>,
  normalized: { path?: string; command?: string }
): string[] {
  if (normalized.path) return extractLoadedSkillsFromText(normalized.path);
  if (normalized.command)
    return extractLoadedSkillsFromText(normalized.command);
  const inline = str(args.tool_name);
  return inline ? extractLoadedSkillsFromText(inline) : [];
}

export const grokParser: AgentTranscriptParser = {
  parseTranscript(raw: string): ParsedTranscript {
    const { records, errors } = parseJsonlRecords(raw);
    const events: TranscriptEvent[] = [];

    // Join the adjacent events of one type into one event.
    let textBuffer = '';
    let thoughtBuffer = '';
    const flushText = () => {
      const content = textBuffer.trim();
      textBuffer = '';
      if (content) {
        events.push({ type: 'message', role: 'assistant', content });
      }
    };
    const flushThought = () => {
      const content = thoughtBuffer.trim();
      thoughtBuffer = '';
      if (content) events.push({ type: 'thinking', content });
    };
    const flushAll = () => {
      flushThought();
      flushText();
    };

    // Send each call in the sequence of its start, after its output arrives.
    const pending = new Map<string, PendingCall>();
    const emitResult = (call: PendingCall) => {
      const name = canonicalName(call.originalName, call.call);
      events.push({
        type: 'tool_result',
        tool: {
          name,
          originalName: call.originalName,
          id: call.id,
          result: call.result,
          success: call.success,
        },
      });
    };

    for (const record of records) {
      try {
        switch (record.type) {
          case 'thought': {
            flushText();
            const delta = str(record.data);
            if (delta) thoughtBuffer += delta;
            break;
          }
          case 'text': {
            flushThought();
            const delta = str(record.data);
            if (delta) textBuffer += delta;
            break;
          }
          case 'tool_call': {
            flushAll();
            const id = str(record.toolCallId) ?? '';
            const rawInput = isRecord(record.rawInput) ? record.rawInput : {};
            const emitted = emittedToolName(
              str(record.toolName) ?? 'unknown',
              rawInput
            );

            // A `use_tool` call is an MCP call. All other calls are Grok tools.
            const unwrapped =
              emitted === 'use_tool' ? unwrapUseTool(rawInput) : undefined;
            const originalName = unwrapped?.originalName ?? emitted;
            const args = unwrapped?.args ?? rawInput;
            const call: ToolCall = unwrapped?.call ?? {
              kind: 'other',
              toolName: emitted,
            };

            const normalized = extractArgs(args, GROK_ARG_FIELDS);
            const tool: NonNullable<TranscriptEvent['tool']> = {
              name: canonicalName(originalName, call),
              originalName,
              call,
              id,
              args,
            };
            if (normalized.path) tool.path = normalized.path;
            if (normalized.command) tool.command = normalized.command;
            if (normalized.url) tool.url = normalized.url;
            const skills = loadedSkills(args, normalized);
            if (skills.length > 0) tool.loadedSkills = skills;

            events.push({ type: 'tool_call', tool });
            pending.set(id, { id, originalName, call, args });
            break;
          }
          case 'tool_call_update': {
            const id = str(record.toolCallId) ?? '';
            const call = pending.get(id);
            if (!call) break;
            const success = statusSuccess(record.status);
            if (success === undefined) break; // intermediate; wait for terminal
            call.result = resultPayload(record.rawOutput);
            call.success = bashSuccess(record.rawOutput) ?? success;
            pending.delete(id);
            emitResult(call);
            break;
          }
          case 'error': {
            flushAll();
            const message =
              str(record.message) ??
              (isRecord(record.error) ? str(record.error.message) : undefined);
            events.push({
              type: 'error',
              content: message ?? JSON.stringify(record),
            });
            break;
          }
          case 'end': {
            flushAll();
            break;
          }
          // The `available_commands` and `usage` events make no transcript
          // event. The `extractUsage` function in the runner reads the token
          // data directly from the stream.
          default:
            break;
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    flushAll();
    // A run that stops early can leave a call with no last update. Send these
    // calls with no status, thus the record contains them.
    for (const call of pending.values()) emitResult(call);

    return { events, errors };
  },
};
