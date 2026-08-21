/**
 * System-prompt assembly, per agent harness.
 *
 * An eval measures out-of-the-box agent behaviour, so the harness injects as
 * little prompt of its own as it can get away with: only the ai-sdk agent gets
 * any base framing, because it is the only harness with no system prompt of its
 * own (`aiSdkAgent` hands `systemPrompt` straight to the model's `system`). CLI
 * agents ship their own coding-agent prompt, tool guidance, and stopping
 * behaviour — and codex/opencode have no system-prompt flag at all, so anything
 * we pass them lands on the *user* prompt.
 */

import type { AgentHarnessId } from '@supabase-evals/core';
import type { EvalMode } from './types.js';

/**
 * Base framing for the ai-sdk harness: what it can't infer on its own — that it
 * has tools, and what they act on. Deliberately silent on how to finish a turn
 * (no "end with a summary"): stopping behaviour is part of what's measured.
 * Empty for every CLI harness.
 */
function basePromptFor(agent: AgentHarnessId, mode: EvalMode): string {
  if (agent !== 'ai-sdk') return '';
  if (mode === 'local-stack') {
    return (
      'You are an agent solving a Supabase eval task in a Linux workspace. ' +
      'Use the provided tools to inspect and modify the workspace and run commands.'
    );
  }
  return (
    'You are an agent solving a Supabase eval task. ' +
    'Use the provided tools to inspect and modify the project.'
  );
}

/**
 * Assemble the system prompt handed to the agent. Every block is optional, and
 * every one of them is ai-sdk-only (the base framing, the tool-surface addendum,
 * the skills listing), so a CLI harness ends up with `''` — the CLI engine then
 * stages no system-prompt file at all rather than an empty one.
 */
export function buildSystemPrompt(
  agent: AgentHarnessId,
  mode: EvalMode,
  addendum?: string,
  skillContext?: string
): string {
  const blocks = [basePromptFor(agent, mode), addendum, skillContext].filter(
    Boolean
  );
  return blocks.join('\n\n');
}
