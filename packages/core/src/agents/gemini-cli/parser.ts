/**
 * Gemini CLI transcript parser — for `gemini --output-format stream-json`
 * (CLI ≥ 0.20).
 *
 * The stream is newline-delimited event records (ISO timestamps):
 *   {"type":"init","session_id":"…","model":"gemini-3.1-pro-preview"}
 *   {"type":"message","role":"user","content":"…"}
 *   {"type":"tool_use","tool_name":"run_shell_command","tool_id":"…",
 *      "parameters":{"command":"…"}}
 *   {"type":"tool_result","tool_id":"…","status":"success","output":"…"}
 *   {"type":"message","role":"assistant","content":"…","delta":true}
 *   {"type":"result","status":"success","stats":{…}}
 *
 * `tool_use` and `tool_result` are separate events correlated by `tool_id`.
 * Assistant text streams as `delta:true` chunks, so contiguous assistant
 * messages are merged into one. `init`/`result` carry no transcript content
 * (the runner reads the terminal `result.status` for the stop reason).
 *
 * Adapted from `@supabase/agent-evals` (packages/agent-eval/src/parsers).
 */

import { isRecord, parseJsonlRecords } from "../../json.js";
import type { ParsedTranscript, TranscriptEvent } from "../../transcript/types.js";
import type { AgentTranscriptParser } from "../../parsers/types.js";
import { normalizeToolName, type AgentToolMap } from "../../parsers/shared/normalize.js";
import {
  extractArgs,
  extractLoadedSkillFromText,
  type ArgFieldMap,
} from "../../parsers/shared/extract.js";

/**
 * gemini-cli's tool names → canonical names. gemini-cli names built-in tools
 * with verbose ids (`run_shell_command`, `read_file`, …). Owned here, not in
 * shared. MCP tools arrive under their own name and fall through to `tool_use`.
 */
const GEMINI_CLI_TOOLS: AgentToolMap = {
  caseInsensitive: true,
  tools: {
    run_shell_command: "shell",
    shell: "shell",
    read_file: "file_read",
    read_many_files: "file_read",
    write_file: "file_write",
    replace: "file_edit",
    edit: "file_edit",
    list_directory: "list_dir",
    ls: "list_dir",
    glob: "glob",
    search_file_content: "grep",
    grep: "grep",
    google_web_search: "web_search",
    web_search: "web_search",
    web_fetch: "web_fetch",
    save_memory: "agent_task",
    // Session-management built-ins (0.46+): no external effect, agent housekeeping.
    update_topic: "agent_task",
  },
};

/**
 * gemini-cli tool args → normalized fields. `run_shell_command` carries the
 * command in `command`; file tools the path in `file_path`/`absolute_path`.
 */
const GEMINI_CLI_ARG_FIELDS: ArgFieldMap = {
  path: ["file_path", "absolute_path", "path", "filename"],
  command: ["command"],
  url: ["url"],
};

/** Epoch-ms (or pass-through ISO) → ISO string. */
function toISO(value: unknown): string | undefined {
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") return value;
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Identifies gemini-cli skill loads from normalized file paths or shell commands. */
function loadedSkillFromGeminiCall(
  tool: NonNullable<TranscriptEvent["tool"]>,
): string | undefined {
  if (tool.path) return extractLoadedSkillFromText(tool.path);
  if (tool.command) return extractLoadedSkillFromText(tool.command);
  return undefined;
}

function recordToEvents(data: Record<string, unknown>): TranscriptEvent[] {
  const type = str(data.type);
  if (!type) return [];
  const timestamp = toISO(data.timestamp);

  switch (type) {
    case "message": {
      const role = str(data.role);
      const content = str(data.content);
      if (!content || (role !== "user" && role !== "assistant" && role !== "system")) return [];
      return [{ timestamp, type: "message", role, content, raw: data }];
    }
    case "tool_use": {
      const originalName = str(data.tool_name) ?? "unknown";
      const id = str(data.tool_id);
      const args = isRecord(data.parameters) ? data.parameters : {};
      const name = normalizeToolName(originalName, GEMINI_CLI_TOOLS);
      const normalized = extractArgs(args, GEMINI_CLI_ARG_FIELDS);
      const tool: NonNullable<TranscriptEvent["tool"]> = { name, originalName, id, args };
      if (normalized.path) tool.path = normalized.path;
      if (normalized.command) tool.command = normalized.command;
      if (normalized.url) tool.url = normalized.url;
      tool.loadedSkill = loadedSkillFromGeminiCall(tool);
      return [{ timestamp, type: "tool_call", tool, raw: data }];
    }
    case "tool_result": {
      // The adapter pairs call↔result by `id` and reads the name from the
      // tool_call, so the result's own name isn't authoritative — keep `id` as
      // the correlation key (mirrors claude-code's tool_result handling).
      const id = str(data.tool_id);
      const status = str(data.status);
      return [
        {
          timestamp,
          type: "tool_result",
          tool: {
            name: "unknown",
            originalName: id ?? "unknown",
            id,
            result: data.output ?? data.error,
            success: status === undefined ? undefined : status === "success",
          },
          raw: data,
        },
      ];
    }
    case "error": {
      const message =
        (isRecord(data.error) && str(data.error.message)) || str(data.message) || str(data.error);
      return [{ timestamp, type: "error", content: message ?? JSON.stringify(data), raw: data }];
    }
    // init / result carry no transcript content.
    default:
      return [];
  }
}

/**
 * Fold a streamed assistant `delta` message into the preceding assistant
 * message. gemini streams an assistant turn as `delta:true` chunks; only those
 * are merged, so a distinct (non-delta) assistant message stays its own turn.
 */
function mergeAssistantDeltas(events: TranscriptEvent[]): TranscriptEvent[] {
  const isDelta = (e: TranscriptEvent) => isRecord(e.raw) && e.raw.delta === true;
  const out: TranscriptEvent[] = [];
  for (const event of events) {
    const prev = out[out.length - 1];
    if (
      event.type === "message" &&
      event.role === "assistant" &&
      isDelta(event) &&
      prev?.type === "message" &&
      prev.role === "assistant"
    ) {
      prev.content = (prev.content ?? "") + (event.content ?? "");
      continue;
    }
    out.push(event);
  }
  return out;
}

export const geminiCliParser: AgentTranscriptParser = {
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
    return { events: mergeAssistantDeltas(events), errors };
  },
};
