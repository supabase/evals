/**
 * Gemini CLI agent. Owns everything Gemini-CLI-specific: it wires its own runner
 * + parser into the public `geminiCliAgent` factory (via the generic
 * `createCliAgent` engine) and exports the registry definition the harness uses
 * to parse Gemini CLI transcripts. Runs in both modes, like Claude Code / Codex.
 *
 * gemini-cli exposes no reasoning-effort flag, so — unlike Claude Code / Codex —
 * this factory takes no `reasoningEffort` option.
 */

import type { AgentHarness } from "../../index.js";
import { createCliAgent } from "../engine.js";
import type { AgentDefinition } from "../types.js";
import { geminiCliRunner, type GeminiCliModel } from "./runner.js";
import { geminiCliParser } from "./parser.js";

/** Google's Gemini CLI as an `AgentHarness`. */
export function geminiCliAgent(
  options: {
    /** Gemini model id (typed from `@ai-sdk/google`; any string accepted). */
    model?: GeminiCliModel;
    /** Override the pinned CLI version. */
    cliVersion?: string;
  } = {},
): AgentHarness {
  return createCliAgent(geminiCliRunner, geminiCliParser, {
    model: options.model ?? geminiCliRunner.defaultModel,
    cliVersion: options.cliVersion,
  });
}

/** Runner + parser pairing for the agent registry (id comes from `runner.id`). */
export const geminiCliDefinition: AgentDefinition = {
  runner: geminiCliRunner,
  parser: geminiCliParser,
};
