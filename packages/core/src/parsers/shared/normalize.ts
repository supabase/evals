/**
 * Shared tool-name normalization algorithm.
 *
 * The *mapping* (an agent's raw tool names → canonical `ToolName`) is an agent
 * attribute and lives with that agent's parser; this module owns only the
 * lookup logic and the `AgentToolMap` shape. A parser passes its own map in —
 * shared uses it, but doesn't define it.
 */

import type { ToolName } from "../../transcript/types.js";

/** An agent's tool-name mapping, owned and supplied by that agent's parser. */
export interface AgentToolMap {
  /** The agent's raw tool name → canonical `ToolName`. */
  tools: Record<string, ToolName>;
  /** Match tool names case-insensitively (the name is lowercased before lookup). */
  caseInsensitive?: boolean;
}

/**
 * Normalize an agent-specific tool name to the canonical `ToolName` using the
 * agent's own map. Unmapped MCP-namespaced names (`mcp__server__tool`) fall
 * back to `"tool_use"`; anything else to `"unknown"`. The original name is
 * preserved separately by callers.
 */
export function normalizeToolName(name: string, map: AgentToolMap): ToolName {
  const key = map.caseInsensitive ? name.toLowerCase() : name;
  const mapped = map.tools[key];
  if (mapped) return mapped;
  if (name.startsWith("mcp__")) return "tool_use";
  return "unknown";
}
