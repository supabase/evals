/**
 * Canonical, agent-agnostic transcript vocabulary.
 *
 * Every CLI agent (Claude Code, Codex, Gemini CLI, …) emits its own transcript
 * format. A per-agent parser converts the raw transcript into this shared
 * schema so the rest of the harness — and the adapter into the scorer-facing
 * `TranscriptPart`/`ToolCallRecord` types — never has to know which agent ran.
 *
 * Ported from `@supabase/agent-evals` (packages/agent-eval/src/transcript).
 */

/**
 * Canonical tool names across agents. Each agent's vocabulary is mapped onto
 * these by `normalizeToolName`. `tool_use` is the catch-all for MCP/custom
 * tools; `unknown` is for anything unrecognized.
 */
export type ToolName =
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'shell'
  | 'web_fetch'
  | 'web_search'
  | 'glob'
  | 'grep'
  | 'list_dir'
  | 'agent_task'
  | 'tool_use'
  | 'unknown';

/**
 * A tool call's identity: its agent-agnostic `toolName` plus where it came
 * from. `mcp` is attributed precisely (the parser knows the `server`), so
 * scorers can tell our MCP server's `search_docs` apart from a same-named tool
 * on another server or a native/hosted tool. Everything not attributable to a
 * configured MCP server is `other` (agent built-ins, hosted tools like Codex's
 * web_search, or custom tools).
 *
 * `toolName` is the bare tool name with any agent-specific MCP server prefix
 * stripped (e.g. `query_logs`, not `mcp__supabase-mcp__query_logs`).
 */
export type ToolCall =
  | { kind: 'mcp'; server: string; toolName: string }
  | { kind: 'other'; toolName: string };

/** A single normalized event in an agent transcript. */
export interface TranscriptEvent {
  /** ISO timestamp of the event, when the agent records one. */
  timestamp?: string;
  /** Event kind. */
  type: 'message' | 'tool_call' | 'tool_result' | 'thinking' | 'error';
  /** For `message` events: the speaker. */
  role?: 'user' | 'assistant' | 'system';
  /** Text content (for `message`, `thinking`, `error`). */
  content?: string;
  /** For `tool_call` / `tool_result` events. */
  tool?: {
    /** Canonical tool name. */
    name: ToolName;
    /** Original tool name exactly as the agent emitted it (raw; kept for tracing). */
    originalName: string;
    /**
     * Structured call identity (bare `toolName` + `mcp`/`other` source). Set on
     * `tool_call` events; omitted on `tool_result` (correlated by `id`).
     */
    call?: ToolCall;
    /**
     * Correlation id linking a `tool_call` to its later `tool_result`. Agents
     * that interleave the two (Claude Code's `tool_use_id`) set this so the
     * adapter can pair them.
     */
    id?: string;
    /** Tool arguments (for `tool_call`), as the agent emitted them (raw keys). */
    args?: Record<string, unknown>;
    /**
     * Normalized, agent-agnostic views of common args, extracted by the agent's
     * own parser from its raw arg keys (via its `ArgFieldMap`). Let scorers/UI
     * read a tool's file path / shell command / URL without knowing which keys
     * a given harness uses. Undefined when the tool has no such arg.
     */
    path?: string;
    command?: string;
    url?: string;
    /** Skill names loaded by this call, when the parser can identify any. */
    loadedSkills?: string[];
    /** Tool result payload (for `tool_result`). */
    result?: unknown;
    /** Whether the tool call succeeded (for `tool_result`). */
    success?: boolean;
  };
  /** The raw, unparsed event — kept for debugging. */
  raw?: unknown;
}

/** A parsed transcript: normalized events plus any per-line parse failures. */
export interface ParsedTranscript {
  events: TranscriptEvent[];
  errors: string[];
}
