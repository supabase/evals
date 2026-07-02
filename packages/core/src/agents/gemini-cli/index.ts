/**
 * Gemini CLI agent. Owns everything Gemini-CLI-specific: it wires its own runner
 * + parser into the public `geminiCliAgent` factory (via the generic
 * `createCliAgent` engine) and exports the registry definition the harness uses
 * to parse Gemini CLI transcripts. Runs in both modes, like Claude Code / Codex.
 *
 * gemini-cli has no flag to *set* reasoning effort — it's a per-model default
 * baked into the CLI (e.g. gemini-3.1-pro-preview thinks at `high`). So
 * `reasoningEffort` here is display-only: it records the model's effort in the
 * experiment metadata for benchmark parity with Claude Code / Codex, but is not
 * passed to the CLI (the runner ignores it).
 */

import type { AgentHarness } from "../../index.js";
import type { ReasoningEffortLevel } from "../../eval-metadata.js";
import { createCliAgent } from "../engine.js";
import type { AgentDefinition } from "../types.js";
import { geminiCliRunner, type GeminiCliModel } from "./runner.js";
import { geminiCliParser } from "./parser.js";

/** Google's Gemini CLI as an `AgentHarness`. */
export function geminiCliAgent(
  options: {
    /** Gemini model id (typed from `@ai-sdk/google`; any string accepted). */
    model?: GeminiCliModel;
    /**
     * The model's reasoning effort, for display/benchmark metadata only.
     * gemini-cli has no flag to change it, so this must match the model's own
     * default (e.g. `high` for gemini-3.1-pro-preview) — it is recorded, not applied.
     */
    reasoningEffort?: ReasoningEffortLevel;
    /** Override the pinned CLI version. */
    cliVersion?: string;
  } = {},
): AgentHarness {
  return createCliAgent(geminiCliRunner, geminiCliParser, {
    model: options.model ?? geminiCliRunner.defaultModel,
    reasoningEffort: options.reasoningEffort,
    cliVersion: options.cliVersion,
  });
}

/** Runner + parser pairing for the agent registry (id comes from `runner.id`). */
export const geminiCliDefinition: AgentDefinition = {
  runner: geminiCliRunner,
  parser: geminiCliParser,
};
