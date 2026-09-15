/**
 * Interface every CLI-agent transcript parser implements.
 *
 * A parser is pure: it converts a raw transcript (typically JSONL written by
 * the agent CLI) into canonical `TranscriptEvent`s. It owns no I/O and no
 * agent-specific orchestration — that lives in the CLI agent harness.
 *
 * To add a new agent, implement this interface in `agents/<agent>/parser.ts`
 * and register its definition in `agents/registry.ts`. Nothing else changes.
 */

import type { ParsedTranscript } from '../transcript/types.js';

/**
 * Optional run context for parsers. Some agents (OpenCode) name MCP tools
 * `<server>_<tool>` without a structural marker, so the server is only
 * recoverable by matching the configured server names — which the harness
 * knows but the transcript alone does not. Parsers whose format encodes the
 * server (Claude Code, Codex) ignore this.
 */
export interface ParseContext {
  /** Names of the MCP servers configured for this run. */
  mcpServerNames?: string[];
  /**
   * Raw sidecar transcript the runner fetched alongside `raw` (Codex's session
   * rollout, which has per-item wall-clock timestamps the `--json` stream
   * lacks). Parsers that can correlate the two use it to timestamp events.
   */
  rollout?: string;
}

export interface AgentTranscriptParser {
  parseTranscript(raw: string, ctx?: ParseContext): ParsedTranscript;
}
