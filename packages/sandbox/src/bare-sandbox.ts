import type {
  AgentHarnessId,
  AgentSandbox,
  SkillSource,
} from '@supabase-evals/core';
import { createAgentEnvironment } from './agent-environment.js';
import { toAgentSandbox } from './local-stack-runtime.js';
import { buildSkillsPrompt } from './skills.js';

export interface BareSandboxHandle {
  sandbox: AgentSandbox;
  /**
   * Skills-discovery text to fold into the agent's system prompt. Empty for
   * every CLI harness — each discovers the installed skills natively and
   * advertises them to the model itself (see `buildSkillsPrompt`).
   */
  promptAddendum: string;
  close(): Promise<void>;
}

export interface BareSandboxOptions {
  /** Harness driving this sandbox; decides whether skills are advertised in the prompt. */
  agent: AgentHarnessId;
  /** Supabase CLI version baked into the sandbox image. */
  cliVersion?: string;
  /** Skills to install into the sandbox. */
  skills?: readonly SkillSource[];
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
  options: BareSandboxOptions
): Promise<BareSandboxHandle> {
  const env = await createAgentEnvironment({
    cliVersion: options.cliVersion,
    skills: options.skills,
  });
  return {
    sandbox: toAgentSandbox(env.sandbox),
    promptAddendum: buildSkillsPrompt(options.agent, env.skills),
    close: env.close,
  };
}
