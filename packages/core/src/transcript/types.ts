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
 * Reference to the delegated subagent an event belongs to. Agent-agnostic:
 * any harness that delegates work (Claude Code's Task/Agent tool, …) can
 * populate it; consumers use it to keep subagent activity distinct from the
 * main thread (e.g. the final report and step count).
 */
export interface SubagentRef {
  /** Correlation id of the spawning `agent_task` tool call (its `tool.id`). */
  id?: string;
  /** Subagent kind as the harness names it (e.g. "general-purpose"). */
  type?: string;
  /** Task description the parent gave the subagent. */
  description?: string;
}

/** A single normalized event in an agent transcript. */
export interface TranscriptEvent {
  /** ISO timestamp of the event, when the agent records one. */
  timestamp?: string;
  /** Event kind. */
  type: 'message' | 'tool_call' | 'tool_result' | 'thinking' | 'error';
  /** Set when the event happened inside a delegated subagent, not the main thread. */
  subagent?: SubagentRef;
  /** For `message` events: the speaker. */
  role?: 'user' | 'assistant' | 'system';
  /** Text content (for `message`, `thinking`, `error`). */
  content?: string;
  /** For `tool_call` / `tool_result` events. */
  tool?: {
    /** Canonical tool name. */
    name: ToolName;
    /** Original tool name as the agent emitted it (the scorer-facing endpoint). */
    originalName: string;
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
    /** Skill name loaded by this call, when the parser can identify one. */
    loadedSkill?: string;
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
