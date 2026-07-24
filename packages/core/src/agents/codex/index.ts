/**
 * OpenAI Codex agent. Owns everything Codex-specific: it wires its own runner +
 * parser into the public `codexAgent` factory (via the generic `createCliAgent`
 * engine) and exports the registry definition the harness uses to parse Codex
 * transcripts. Runs in both modes, like Claude Code.
 */

import type { AgentHarness } from "../../index.js";
import type { ReasoningEffortLevel } from "../../eval-metadata.js";
import { createCliAgent } from "../engine.js";
import type { AgentDefinition } from "../types.js";
import { codexRunner, type CodexModel } from "./runner.js";
import { codexParser } from "./parser.js";

/** OpenAI Codex as an `AgentHarness`. */
export function codexAgent(
  options: {
    /** OpenAI model id (typed from `openai`; any string accepted). */
    model?: CodexModel;
    /** Reasoning effort (`model_reasoning_effort`). Omit to use Codex's default. */
    reasoningEffort?: ReasoningEffortLevel;
    /** Override the pinned CLI version. */
    cliVersion?: string;
    /** Route through the Vercel AI Gateway instead of the OpenAI API. */
    gateway?: boolean;
  } = {},
): AgentHarness {
  return createCliAgent(codexRunner, codexParser, {
    model: options.model ?? codexRunner.defaultModel,
    reasoningEffort: options.reasoningEffort,
    cliVersion: options.cliVersion,
    gateway: options.gateway,
  });
}

/** Runner + parser pairing for the agent registry (id comes from `runner.id`). */
export const codexDefinition: AgentDefinition = {
  runner: codexRunner,
  parser: codexParser,
};
