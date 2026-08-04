/**
 * Cursor agent. Owns everything Cursor-specific: it wires its own runner +
 * parser into the public `cursorAgent` factory (via the generic `createCliAgent`
 * engine) and exports the registry definition the harness uses to parse Cursor
 * transcripts.
 */

import type { AgentHarness } from '../../index.js';
import type { ReasoningEffortLevel } from '../../eval-metadata.js';
import { createCliAgent } from '../engine.js';
import type { AgentDefinition } from '../types.js';
import { cursorParser } from './parser.js';
import { cursorRunner, type CursorModel } from './runner.js';

/** Cursor CLI agent as an `AgentHarness`. */
export function cursorAgent(
  options: {
    /** Cursor model id from `cursor-agent --list-models` (e.g. composer-2.5). */
    model?: CursorModel;
    /**
     * Reasoning effort applied as Cursor's `model[effort=…]` syntax.
     * Omit to use Cursor's default for the model.
     */
    reasoningEffort?: ReasoningEffortLevel;
    /** Override the pinned CLI tarball version. */
    cliVersion?: string;
  } = {}
): AgentHarness {
  return createCliAgent(cursorRunner, cursorParser, {
    model: options.model ?? cursorRunner.defaultModel,
    reasoningEffort: options.reasoningEffort,
    cliVersion: options.cliVersion,
  });
}

/** Runner + parser pairing for the agent registry (id comes from `runner.id`). */
export const cursorDefinition: AgentDefinition = {
  runner: cursorRunner,
  parser: cursorParser,
};
