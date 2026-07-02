/**
 * Cursor CLI agent. Owns everything Cursor-CLI-specific: it wires its own runner
 * + parser into the public `cursorCliAgent` factory (via the generic
 * `createCliAgent` engine) and exports the registry definition the harness uses
 * to parse Cursor CLI transcripts. Runs in both modes, like Claude Code / Codex.
 *
 * Cursor has no low/medium/high effort dial — only "Max mode" (off by default).
 * So `reasoningEffort` here is display-only: set it to `max` to record that Max
 * mode is on (for benchmark metadata parity), or omit it for the default fast
 * mode. It is recorded, not applied — cursor-agent exposes no flag to toggle it.
 */

import type { AgentHarness } from "../../index.js";
import type { ReasoningEffortLevel } from "../../eval-metadata.js";
import { createCliAgent } from "../engine.js";
import type { AgentDefinition } from "../types.js";
import { cursorCliRunner, type CursorCliModel } from "./runner.js";
import { cursorCliParser } from "./parser.js";

/** Cursor's CLI (`cursor-agent`) as an `AgentHarness`. */
export function cursorCliAgent(
  options: {
    /** Cursor model id (e.g. `composer-2.5`). */
    model?: CursorCliModel;
    /**
     * Display-only effort metadata. Cursor has no low/medium/high dial — only
     * Max mode — so the only settable value is `max` (Max mode on); omit it for
     * the default fast mode.
     */
    reasoningEffort?: Extract<ReasoningEffortLevel, "max">;
    /** Override the pinned CLI version. */
    cliVersion?: string;
  } = {},
): AgentHarness {
  return createCliAgent(cursorCliRunner, cursorCliParser, {
    model: options.model ?? cursorCliRunner.defaultModel,
    reasoningEffort: options.reasoningEffort,
    cliVersion: options.cliVersion,
  });
}

/** Runner + parser pairing for the agent registry (id comes from `runner.id`). */
export const cursorCliDefinition: AgentDefinition = {
  runner: cursorCliRunner,
  parser: cursorCliParser,
};
