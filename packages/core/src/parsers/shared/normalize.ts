/**
 * Shared tool-name normalization for agent transcript parsers.
 *
 * Each agent names its built-in tools differently; this maps those names onto
 * the canonical `ToolName` vocabulary. Adding a new agent is one new map plus
 * one entry in `AGENT_MAPS` (and `CASE_INSENSITIVE_AGENTS` if it lowercases
 * tool names). Unrecognized names fall back to `"unknown"`.
 */

import type { ToolName } from "../../transcript/types.js";

/** Claude Code tool names (case-sensitive). */
const CLAUDE_CODE_MAP: Record<string, ToolName> = {
  // File operations
  Read: "file_read",
  Write: "file_write",
  Edit: "file_edit",
  MultiEdit: "file_edit",
  NotebookEdit: "file_edit",
  // Shell
  Bash: "shell",
  BashOutput: "shell",
  KillShell: "shell",
  // Web
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  // Search / navigation
  Glob: "glob",
  Grep: "grep",
  LS: "list_dir",
  // Agent / subagent
  Task: "agent_task",
  TodoWrite: "agent_task",
};

/** Per-agent name maps, keyed by agent id. */
const AGENT_MAPS: Record<string, Record<string, ToolName>> = {
  "claude-code": CLAUDE_CODE_MAP,
};

/** Agents whose tool names are matched case-insensitively. */
const CASE_INSENSITIVE_AGENTS = new Set<string>([]);

/**
 * Normalize an agent-specific tool name to the canonical `ToolName`.
 *
 * MCP tools (Claude Code prefixes them `mcp__server__tool`) and any name not
 * in the agent's map fall back to `"tool_use"` for MCP-shaped names and
 * `"unknown"` otherwise — the original name is preserved separately by callers.
 */
export function normalizeToolName(name: string, agent: string): ToolName {
  const map = AGENT_MAPS[agent];
  if (map) {
    const key = CASE_INSENSITIVE_AGENTS.has(agent) ? name.toLowerCase() : name;
    if (map[key]) return map[key];
  }
  // MCP tools are namespaced (e.g. `mcp__supabase__search_docs`); treat any
  // unmapped namespaced tool as a generic tool call rather than `unknown`.
  if (name.startsWith("mcp__")) return "tool_use";
  return "unknown";
}
