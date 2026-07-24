/**
 * Claude Code agent. Owns everything Claude-Code-specific: it wires its own
 * runner + parser into the public `claudeCodeAgent` factory (via the generic
 * `createCliAgent` engine) and exports the registry definition the harness uses
 * to parse Claude Code transcripts.
 */

import type { AgentHarness } from "../../index.js";
import type { ReasoningEffortLevel } from "../../eval-metadata.js";
import { createCliAgent } from "../engine.js";
import type { AgentDefinition } from "../types.js";
import { claudeCodeRunner, type ClaudeCodeModel } from "./runner.js";
import { claudeCodeParser } from "./parser.js";

/** Claude Code as an `AgentHarness`. */
export function claudeCodeAgent(
  options: {
    /**
     * Anthropic model id (typed from `@anthropic-ai/sdk`). Defaults to Sonnet.
     * With `gateway`, any AI Gateway `vendor/model` slug is accepted.
     */
    model?: ClaudeCodeModel;
    /** Reasoning effort (`--effort`). Omit to use Claude Code's own default. */
    reasoningEffort?: ReasoningEffortLevel;
    /** Override the pinned CLI version. */
    cliVersion?: string;
    /** Route through the Vercel AI Gateway instead of the Anthropic API. */
    gateway?: boolean;
  } = {},
): AgentHarness {
  return createCliAgent(claudeCodeRunner, claudeCodeParser, {
    model: options.model ?? claudeCodeRunner.defaultModel,
    reasoningEffort: options.reasoningEffort,
    cliVersion: options.cliVersion,
    gateway: options.gateway,
  });
}

/** Runner + parser pairing for the agent registry (id comes from `runner.id`). */
export const claudeCodeDefinition: AgentDefinition = {
  runner: claudeCodeRunner,
  parser: claudeCodeParser,
};
