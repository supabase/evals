/**
 * OpenCode agent. Owns everything opencode-specific: it wires its own runner +
 * parser into the public `opencodeAgent` factory (via the generic
 * `createCliAgent` engine) and exports the registry definition the harness uses
 * to parse opencode transcripts.
 */

import type { AgentHarness } from '../../index.js';
import { createCliAgent } from '../engine.js';
import type { AgentDefinition } from '../types.js';
import {
  DEFAULT_OPENCODE_MODEL,
  createOpencodeRunner,
  type OpenCodeModel,
} from './runner.js';
import { opencodeParser } from './parser.js';

/**
 * OpenCode as an `AgentHarness`. Every run routes through the Vercel AI
 * Gateway (opencode's native `vercel` provider), so the model id is a gateway
 * `vendor/model` slug and the only credential is `AI_GATEWAY_API_KEY` — see
 * `./runner.ts`.
 */
export function opencodeAgent(
  options: {
    /** Gateway model slug, `vendor/model` (e.g. `moonshotai/kimi-k3`). */
    model?: OpenCodeModel;
    /** Override the pinned CLI version. */
    cliVersion?: string;
  } = {}
): AgentHarness {
  const model = options.model ?? DEFAULT_OPENCODE_MODEL;
  return createCliAgent(createOpencodeRunner(model), opencodeParser, {
    model,
    cliVersion: options.cliVersion,
  });
}

/** Runner + parser pairing for the agent registry (id comes from `runner.id`). */
export const opencodeDefinition: AgentDefinition = {
  runner: createOpencodeRunner(DEFAULT_OPENCODE_MODEL),
  parser: opencodeParser,
};
