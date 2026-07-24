/**
 * OpenCode agent. Owns everything opencode-specific: it wires its own runner +
 * parser into the public `opencodeAgent` factory (via the generic
 * `createCliAgent` engine) and exports the registry definition the harness uses
 * to parse opencode transcripts. Runs in both modes, like Claude Code / Codex.
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
 * OpenCode as an `AgentHarness`. Multi-provider: the `provider/model` id selects
 * the credential (anthropic / openai / google), so the runner is built per-model
 * with the matching API-key env var and provider.
 */
export function opencodeAgent(
  options: {
    /**
     * opencode model id, `provider/model` (e.g. `openai/gpt-5.4`). With
     * `gateway`, this is the AI Gateway `vendor/model` slug (e.g.
     * `moonshotai/kimi-k3`) — see `./runner.ts`.
     */
    model?: OpenCodeModel;
    /** Override the pinned CLI version. */
    cliVersion?: string;
    /** Route through the Vercel AI Gateway instead of the vendor's own key. */
    gateway?: boolean;
  } = {}
): AgentHarness {
  const model = options.model ?? DEFAULT_OPENCODE_MODEL;
  return createCliAgent(createOpencodeRunner(model), opencodeParser, {
    model,
    cliVersion: options.cliVersion,
    gateway: options.gateway,
  });
}

/** Runner + parser pairing for the agent registry (id comes from `runner.id`). */
export const opencodeDefinition: AgentDefinition = {
  runner: createOpencodeRunner(DEFAULT_OPENCODE_MODEL),
  parser: opencodeParser,
};
