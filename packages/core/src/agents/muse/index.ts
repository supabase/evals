/**
 * Muse Code agent. Owns everything Muse-specific: it wires its own runner +
 * parser into the public `museAgent` factory (via the generic `createCliAgent`
 * engine) and exports the registry definition the harness uses to parse Muse
 * transcripts.
 */

import type { AgentHarness } from '../../index.js';
import type { ReasoningEffortLevel } from '../../eval-metadata.js';
import { createCliAgent } from '../engine.js';
import type { AgentDefinition } from '../types.js';
import { DEFAULT_MUSE_MODEL, museRunner, type MuseModel } from './runner.js';
import { museParser } from './parser.js';

/**
 * Muse Code, Meta's coding agent CLI, as an `AgentHarness`. Authenticates with
 * `META_API_KEY` and calls Meta's API directly. See `./runner.ts`.
 */
export function museAgent(
  options: {
    /** Muse model id (`--model`). Defaults to {@link DEFAULT_MUSE_MODEL}. */
    model?: MuseModel;
    /**
     * Reasoning effort (`--reasoning-effort`). Muse resolves different base
     * instructions per effort, so experiments should set it explicitly.
     */
    reasoningEffort?: ReasoningEffortLevel;
    /** Override the pinned build (must be listed in `MUSE_RELEASES`). */
    cliVersion?: string;
  } = {}
): AgentHarness {
  return createCliAgent(museRunner, museParser, {
    model: options.model ?? DEFAULT_MUSE_MODEL,
    reasoningEffort: options.reasoningEffort,
    cliVersion: options.cliVersion,
  });
}

/** Runner + parser pairing for the agent registry (id comes from `runner.id`). */
export const museDefinition: AgentDefinition = {
  runner: museRunner,
  parser: museParser,
};
