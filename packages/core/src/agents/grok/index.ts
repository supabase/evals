/**
 * Grok agent. Owns everything Grok-specific: it wires its own runner + parser
 * into the public `grokAgent` factory (via the generic `createCliAgent` engine)
 * and exports the registry definition the harness uses to parse Grok
 * transcripts.
 */

import type { AgentHarness } from '../../index.js';
import type { ReasoningEffortLevel } from '../../eval-metadata.js';
import { createCliAgent } from '../engine.js';
import type { AgentDefinition } from '../types.js';
import { DEFAULT_GROK_MODEL, grokRunner, type GrokModel } from './runner.js';
import { grokParser } from './parser.js';

/**
 * Grok CLI as an `AgentHarness`. Authenticates with `XAI_API_KEY` and runs
 * against xAI directly — unlike `opencodeAgent`, which reaches Grok through the
 * Vercel AI Gateway inside a third-party harness. See `./runner.ts`.
 */
export function grokAgent(
  options: {
    /** Grok model id (`--model`). Defaults to {@link DEFAULT_GROK_MODEL}. */
    model?: GrokModel;
    /** Reasoning effort (`--reasoning-effort`). Omit for Grok's own default. */
    reasoningEffort?: ReasoningEffortLevel;
    /** Override the pinned CLI version. */
    cliVersion?: string;
  } = {}
): AgentHarness {
  return createCliAgent(grokRunner, grokParser, {
    model: options.model ?? DEFAULT_GROK_MODEL,
    reasoningEffort: options.reasoningEffort,
    cliVersion: options.cliVersion,
  });
}

/** Runner + parser pairing for the agent registry (id comes from `runner.id`). */
export const grokDefinition: AgentDefinition = {
  runner: grokRunner,
  parser: grokParser,
};
