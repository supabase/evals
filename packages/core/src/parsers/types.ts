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

import type { ParsedTranscript } from "../transcript/types.js";

export interface AgentTranscriptParser {
  parseTranscript(raw: string): ParsedTranscript;
}
