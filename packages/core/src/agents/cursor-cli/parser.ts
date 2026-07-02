/**
 * Cursor CLI transcript parser — for `cursor-agent --output-format stream-json`.
 *
 * The stream is newline-delimited SDK-message events:
 *   {"type":"system","subtype":"init","model":"…","session_id":"…"}
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
 *   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"…"}]}}
 *   {"type":"tool_call","subtype":"started","call_id":"…","tool_call":{"shellToolCall":{"args":{…}}}}
 *   {"type":"tool_call","subtype":"completed","call_id":"…","tool_call":{"shellToolCall":{"args":{…},"result":{"success":{…}}}}}
 *   {"type":"result","subtype":"success","is_error":false,"result":"<final text>"}
 *
 * A tool call's *type* is the single `*ToolCall` key inside `tool_call` (e.g.
 * `shellToolCall`, `readToolCall`); `started`/`completed` are correlated by
 * `call_id`. Assistant events carry the full message text (not deltas, since we
 * don't pass `--stream-partial-output`). Cursor may also emit `thinking` events
 * (its hidden reasoning); only the `completed` one carries the full text.
 * `system`/`result` carry no transcript content (the runner reads the terminal
 * `result` for the stop reason).
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
 * cursor-agent's tool-call keys → canonical names. Cursor names built-in tools
 * by the `*ToolCall` key wrapping their payload. Owned here, not in shared.
 * Unmapped keys fall through to `unknown`.
 */
const CURSOR_CLI_TOOLS: AgentToolMap = {
  tools: {
    readToolCall: "file_read",
    writeToolCall: "file_write",
    editToolCall: "file_edit",
    deleteToolCall: "file_write",
    shellToolCall: "shell",
    grepToolCall: "grep",
    globToolCall: "glob",
    lsToolCall: "list_dir",
    searchToolCall: "web_search",
    fetchToolCall: "web_fetch",
    updateTodosToolCall: "agent_task",
  },
};

/**
 * cursor-agent tool args → normalized fields (key names observed across Cursor's
 * built-in tools). `shell` carries the command in `command`; file tools the path
 * in `path`/`file_path`/…; `fetch` the URL in `url`/`uri`.
 */
const CURSOR_CLI_ARG_FIELDS: ArgFieldMap = {
  path: ["path", "file_path", "filePath", "file", "filename", "target"],
  command: ["command", "cmd"],
  url: ["url", "uri", "href"],
};

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Epoch-ms (or pass-through ISO) → ISO string. */
function toISO(value: unknown): string | undefined {
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") return value;
  return undefined;
}

/** Join the `text` blocks of a Cursor `message.content` array (or a plain string). */
function extractMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((c): c is Record<string, unknown> => isRecord(c) && c.type === "text")
    .map((c) => str(c.text))
    .filter((t): t is string => Boolean(t));
  return texts.length > 0 ? texts.join("") : undefined;
}

/** The single `*ToolCall` key inside a `tool_call` object, and its payload. */
function findToolCall(
  toolCall: Record<string, unknown>,
): { key: string; inner: Record<string, unknown> } | undefined {
  for (const key of Object.keys(toolCall)) {
    if (key.endsWith("ToolCall") && isRecord(toolCall[key])) {
      return { key, inner: toolCall[key] as Record<string, unknown> };
    }
  }
  return undefined;
}

/** Cursor tool result is `{ success: {...} }` on success, `{ error: {...} }` on failure. */
function resultSuccess(result: unknown): boolean | undefined {
  if (!isRecord(result)) return undefined;
  if ("success" in result) return true;
  if ("error" in result) return false;
  return undefined;
}

function recordToEvents(data: Record<string, unknown>): TranscriptEvent[] {
  const type = str(data.type);
  if (!type) return [];
  const timestamp = toISO(data.timestamp_ms);

  switch (type) {
    case "user":
    case "assistant": {
      const message = isRecord(data.message) ? data.message : undefined;
      const content = message ? extractMessageText(message.content) : undefined;
      if (!content) return [];
      return [{ timestamp, type: "message", role: type, content, raw: data }];
    }
    case "thinking": {
      // Only the completed reasoning block carries the full text; skip deltas.
      if (data.subtype !== "completed") return [];
      const content = str(data.text);
      return content ? [{ timestamp, type: "thinking", content, raw: data }] : [];
    }
    case "tool_call": {
      const toolCall = isRecord(data.tool_call) ? findToolCall(data.tool_call) : undefined;
      if (!toolCall) return [];
      const id = str(data.call_id);
      const name = normalizeToolName(toolCall.key, CURSOR_CLI_TOOLS);

      if (data.subtype === "started") {
        const args = isRecord(toolCall.inner.args) ? toolCall.inner.args : {};
        const normalized = extractArgs(args, CURSOR_CLI_ARG_FIELDS);
        const tool: NonNullable<TranscriptEvent["tool"]> = {
          name,
          originalName: toolCall.key,
          id,
          args,
        };
        if (normalized.path) tool.path = normalized.path;
        if (normalized.command) tool.command = normalized.command;
        if (normalized.url) tool.url = normalized.url;
        tool.loadedSkill = loadedSkillFromCursorCall(tool);
        return [{ timestamp, type: "tool_call", tool, raw: data }];
      }
      if (data.subtype === "completed") {
        // Pair with the call by `id`; the adapter reads the name off the
        // tool_call, so the result's own name isn't authoritative.
        return [
          {
            timestamp,
            type: "tool_result",
            tool: {
              name,
              originalName: toolCall.key,
              id,
              result: toolCall.inner.result,
              success: resultSuccess(toolCall.inner.result),
            },
            raw: data,
          },
        ];
      }
      return [];
    }
    case "result": {
      // Only surface a terminal error here; the final assistant text already
      // arrived as an `assistant` event. Success carries no transcript content.
      if (data.is_error !== true && data.subtype !== "error" && data.status !== "error") {
        return [];
      }
      const error = isRecord(data.error) ? data.error : undefined;
      const message = (error && str(error.message)) || str(data.result) || JSON.stringify(data);
      return [{ timestamp, type: "error", content: message, raw: data }];
    }
    // system/init and other metadata events carry no transcript content.
    default:
      return [];
  }
}

/** Identifies Cursor skill loads from normalized file paths or shell commands. */
function loadedSkillFromCursorCall(
  tool: NonNullable<TranscriptEvent["tool"]>,
): string | undefined {
  if (tool.path) return extractLoadedSkillFromText(tool.path);
  if (tool.command) return extractLoadedSkillFromText(tool.command);
  return undefined;
}

export const cursorCliParser: AgentTranscriptParser = {
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
