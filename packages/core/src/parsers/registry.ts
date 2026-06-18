/**
 * Transcript-parser registry: maps an agent id to its parser.
 *
 * Adding a new agent is one import + one map entry here (plus the parser file
 * and a tool-name map in `shared/normalize.ts`).
 */

import type { AgentTranscriptParser } from "./types.js";
import { claudeCodeParser } from "./claude-code.js";
import { codexParser } from "./codex.js";

const PARSERS: Record<string, AgentTranscriptParser> = {
  "claude-code": claudeCodeParser,
  codex: codexParser,
};

/** Agent ids with a registered transcript parser. */
export function supportedParsers(): string[] {
  return Object.keys(PARSERS);
}

/** Look up a parser by agent id, or throw with the supported list. */
export function createParser(agent: string): AgentTranscriptParser {
  const parser = PARSERS[agent];
  if (!parser) {
    throw new Error(
      `Unknown agent parser: "${agent}". Supported: ${supportedParsers().join(", ")}`,
    );
  }
  return parser;
}
