/**
 * Claude Code transcript parser.
 *
 * Parses the stream-json JSONL that `claude --print --output-format stream-json`
 * writes to stdout (the runner reads it from there, not the on-disk session
 * file, to avoid the session-file write race). Each line is one event;
 * assistant lines nest the payload under `message` (Anthropic Messages shape),
 * tool results arrive on `user` lines as `tool_result` content blocks, and the
 * run ends with a top-level `result` line carrying the final text.
 *
 * Adapted from `@supabase/agent-evals` (packages/agent-eval/src/parsers).
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
  extractLoadedSkillFromText,
  type ArgFieldMap,
} from '../../parsers/shared/extract.js';

/** Claude Code's tool names → canonical names (case-sensitive). Owned here, not in shared. */
const CLAUDE_CODE_TOOLS: AgentToolMap = {
  tools: {
    // File operations
    Read: 'file_read',
    Write: 'file_write',
    Edit: 'file_edit',
    MultiEdit: 'file_edit',
    NotebookEdit: 'file_edit',
    // Shell
    Bash: 'shell',
    BashOutput: 'shell',
    KillShell: 'shell',
    // Web
    WebFetch: 'web_fetch',
    WebSearch: 'web_search',
    // Search / navigation
    Glob: 'glob',
    Grep: 'grep',
    LS: 'list_dir',
    // Agent / subagent
    Task: 'agent_task',
    TodoWrite: 'agent_task',
  },
};

/**
 * Claude Code's tool args → normalized fields. Owned here, not in shared: Read/
 * Write/Edit carry the path in `file_path`, NotebookEdit in `notebook_path`,
 * Bash the command in `command`, WebFetch the URL in `url`. The shared extractor
 * just reads whichever keys this map names.
 */
const CLAUDE_CODE_ARG_FIELDS: ArgFieldMap = {
  path: ['file_path', 'notebook_path'],
  command: ['command'],
  url: ['url'],
};

/** Content array, handling the `{ message: { content } }` nesting. */
function getContentArray(data: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(data.content)) return data.content;
  const message = data.message as Record<string, unknown> | undefined;
  if (message && Array.isArray(message.content)) return message.content;
  return undefined;
}

/** String content, handling the `{ message: { content } }` nesting. */
function getStringContent(data: Record<string, unknown>): string | undefined {
  if (typeof data.content === 'string') return data.content;
  const message = data.message as Record<string, unknown> | undefined;
  if (message && typeof message.content === 'string') return message.content;
  return undefined;
}

/** Join all `text` blocks (or a plain string body) into one string. */
function extractText(data: Record<string, unknown>): string | undefined {
  const stringContent = getStringContent(data);
  if (stringContent) return stringContent;

  const contentArray = getContentArray(data);
  if (contentArray) {
    const texts = contentArray
      .filter(
        (b): b is Record<string, unknown> => isRecord(b) && b.type === 'text'
      )
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean);
    if (texts.length > 0) return texts.join('\n');
  }
  return undefined;
}

/** Join all `thinking` blocks into one string. */
function extractThinking(data: Record<string, unknown>): string | undefined {
  const contentArray = getContentArray(data);
  if (!contentArray) return undefined;
  const texts = contentArray
    .filter(
      (b): b is Record<string, unknown> => isRecord(b) && b.type === 'thinking'
    )
    .map((b) => (typeof b.thinking === 'string' ? b.thinking : ''))
    .filter(Boolean);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

interface ToolUse {
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

/** Pull `tool_use` blocks out of an assistant message. */
function extractToolUses(data: Record<string, unknown>): ToolUse[] {
  const contentArray = getContentArray(data);
  if (!contentArray) return [];
  const uses: ToolUse[] = [];
  for (const block of contentArray) {
    if (!isRecord(block) || block.type !== 'tool_use') continue;
    uses.push({
      id: typeof block.id === 'string' ? block.id : undefined,
      name: typeof block.name === 'string' ? block.name : 'unknown',
      input: isRecord(block.input) ? block.input : {},
    });
  }
  return uses;
}

/**
 * Attach normalized path/command/url views to a tool-call event, in place,
 * using Claude Code's own arg-key map. Leaves `args` untouched (raw); the
 * normalized values live on the event's `tool` for agent-agnostic consumers.
 */
function enrich(event: TranscriptEvent): TranscriptEvent {
  if (event.type !== 'tool_call' || !event.tool) return event;
  const { path, command, url } = extractArgs(
    event.tool.args ?? {},
    CLAUDE_CODE_ARG_FIELDS
  );
  if (path) event.tool.path = path;
  if (command) event.tool.command = command;
  if (url) event.tool.url = url;
  event.tool.loadedSkill = loadedSkillFromClaudeCodeCall(event.tool);
  return event;
}

/** Identifies Claude Code skill loads from tool-specific args or file reads. */
function loadedSkillFromClaudeCodeCall(
  tool: NonNullable<TranscriptEvent['tool']>
): string | undefined {
  if (tool.originalName === 'Skill' && typeof tool.args?.skill === 'string') {
    return tool.args.skill;
  }
  if (tool.path) return extractLoadedSkillFromText(tool.path);
  if (tool.command) return extractLoadedSkillFromText(tool.command);
  return undefined;
}

function recordToEvents(data: Record<string, unknown>): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const timestamp =
    typeof data.timestamp === 'string' ? data.timestamp : undefined;
  const type = data.type;

  if (type === 'user' || data.role === 'user') {
    const toolResults = getContentArray(data)?.filter(
      (b): b is Record<string, unknown> =>
        isRecord(b) && b.type === 'tool_result'
    );
    if (toolResults && toolResults.length > 0) {
      for (const r of toolResults) {
        events.push({
          timestamp,
          type: 'tool_result',
          tool: {
            name: 'unknown',
            originalName:
              typeof r.tool_use_id === 'string' ? r.tool_use_id : 'unknown',
            id: typeof r.tool_use_id === 'string' ? r.tool_use_id : undefined,
            result: r.content,
            success: !r.is_error,
          },
          raw: r,
        });
      }
    } else {
      const content = extractText(data);
      if (content) {
        events.push({
          timestamp,
          type: 'message',
          role: 'user',
          content,
          raw: data,
        });
      }
    }
  } else if (type === 'assistant' || data.role === 'assistant') {
    const content = extractText(data);
    if (content) {
      events.push({
        timestamp,
        type: 'message',
        role: 'assistant',
        content,
        raw: data,
      });
    }
    const thinking = extractThinking(data);
    if (thinking) {
      events.push({
        timestamp,
        type: 'thinking',
        content: thinking,
        raw: data,
      });
    }
    for (const use of extractToolUses(data)) {
      events.push(
        enrich({
          timestamp,
          type: 'tool_call',
          tool: {
            name: normalizeToolName(use.name, CLAUDE_CODE_TOOLS),
            originalName: use.name,
            id: use.id,
            args: use.input,
          },
          raw: use,
        })
      );
    }
  } else if (type === 'system') {
    const content = extractText(data);
    if (content) {
      events.push({
        timestamp,
        type: 'message',
        role: 'system',
        content,
        raw: data,
      });
    }
  } else if (type === 'result') {
    // Terminal line of `claude --print`: carries the final assistant text and a
    // subtype (`success`, `error_max_turns`, …). Emit the text as the closing
    // assistant message so report derivation works off events alone.
    const result = typeof data.result === 'string' ? data.result : undefined;
    if (result) {
      events.push({
        timestamp,
        type: 'message',
        role: 'assistant',
        content: result,
        raw: data,
      });
    }
  } else if (type === 'error' || data.error) {
    events.push({
      timestamp,
      type: 'error',
      content: errorMessage(data),
      raw: data,
    });
  }

  return events;
}

function errorMessage(data: Record<string, unknown>): string {
  if (isRecord(data.error) && typeof data.error.message === 'string') {
    return data.error.message;
  }
  if (typeof data.message === 'string') return data.message;
  return JSON.stringify(data.error ?? data);
}

export const claudeCodeParser: AgentTranscriptParser = {
  parseTranscript(raw: string): ParsedTranscript {
    const { records, errors } = parseJsonlRecords(raw);
    const events: TranscriptEvent[] = [];
    let lastAssistantText: string | undefined;
    for (const record of records) {
      try {
        for (const event of recordToEvents(record)) {
          const isAssistantMessage =
            event.type === 'message' && event.role === 'assistant';
          // The terminal `result` line repeats the final assistant message that
          // the preceding `assistant` line already emitted (stream-json carries
          // both). Drop the duplicate, but still emit it when the text was never
          // streamed (e.g. plain `--print` with only a `result` line).
          if (
            isAssistantMessage &&
            record.type === 'result' &&
            event.content === lastAssistantText
          ) {
            continue;
          }
          if (isAssistantMessage) lastAssistantText = event.content;
          events.push(event);
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    return { events, errors };
  },
};
