/**
 * System-prompt assembly, per agent harness.
 *
 * An eval measures the agent as shipped, so the harness adds as little prompt
 * of its own as it can. Only the ai-sdk agent gets any: it is the one harness
 * with no system prompt of its own (`aiSdkAgent` hands `systemPrompt` straight
 * to the model's `system`). Every CLI agent runs with the prompt it ships with,
 * and `createCliAgent` refuses a non-empty one.
 */

import type { AgentHarnessId } from '@supabase-evals/core';

/**
 * Base framing for the ai-sdk harness: only what it cannot infer on its own,
 * that it has tools and should use them. Deliberately says nothing about
 * Supabase, a project, or how to finish a turn: which tools the agent reaches
 * for and when it stops are part of what is measured (see issue #164).
 */
const AI_SDK_BASE_PROMPT =
  'You are an agent. Use the provided tools to complete the task.';

/**
 * Assemble the system prompt for the agent. Every block is ai-sdk-only, so a
 * CLI harness gets `''`. The runtime blocks (tool surface, skills listing) are
 * already empty for a CLI agent at their source; an MCP server's
 * `promptAddendum` is not, and is left to reach `createCliAgent`, which throws.
 */
export function buildSystemPrompt({
  agent,
  addendum,
  skillContext,
}: {
  agent: AgentHarnessId;
  /** Runtime text: the session's tool surface, or the MCP servers' addenda. */
  addendum?: string;
  /** The installed-skills listing. */
  skillContext?: string;
}): string {
  const base = agent === 'ai-sdk' ? AI_SDK_BASE_PROMPT : '';
  return [base, addendum, skillContext].filter(Boolean).join('\n\n');
}
