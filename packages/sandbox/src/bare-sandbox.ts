import type {
  AgentSandbox,
  SandboxMount,
  SkillSource,
} from '@supabase-evals/core';
import { createAgentEnvironment } from './agent-environment.js';
import { toAgentSandbox } from './local-stack-runtime.js';
import { buildSkillsPrompt } from './skills.js';

export interface BareSandboxHandle {
  sandbox: AgentSandbox;
  /** Skills-discovery text to fold into the agent's system prompt. */
  promptAddendum: string;
  close(): Promise<void>;
}

/**
 * The agent's execution environment for tools mode: the shared agent
 * environment (image, tooling, skills) **without** the Supabase local stack.
 * Identical to what a local-stack session gives the agent, minus the running
 * stack — so the CLI agent has the same tools and the same skills in both modes.
 *
 * The eval's tools come from MCP (the in-container servers reach host-side
 * platform-lite via `host.docker.internal` on the default bridge).
 */
export async function createBareSandbox(
  options: {
    cliVersion?: string;
    skills?: readonly SkillSource[];
    mounts?: readonly SandboxMount[];
  } = {}
): Promise<BareSandboxHandle> {
  const env = await createAgentEnvironment({
    cliVersion: options.cliVersion,
    skills: options.skills,
    mounts: options.mounts,
  });
  return {
    sandbox: toAgentSandbox(env.sandbox),
    promptAddendum: buildSkillsPrompt(env.skills),
    close: env.close,
  };
}
