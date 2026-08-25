import type {
  AgentSandbox,
  SandboxMount,
  SkillSource,
} from '@supabase-evals/core';
import { createAgentEnvironment } from './agent-environment.js';
import { toAgentSandbox } from './local-stack-runtime.js';

export interface BareSandboxHandle {
  sandbox: AgentSandbox;
  close(): Promise<void>;
}

export interface BareSandboxOptions {
  /** Supabase CLI version baked into the sandbox image. */
  cliVersion?: string;
  /** Skills to install into the sandbox. */
  skills?: readonly SkillSource[];
  /**
   * Extra host directories bind-mounted into the sandbox (read-only by
   * default) — e.g. a local MCP server build the in-container agent must be
   * able to launch. See `supabaseMcpServerMounts`.
   */
  mounts?: readonly SandboxMount[];
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
    mounts: options.mounts,
  });
  return {
    sandbox: toAgentSandbox(env.sandbox),
    close: env.close,
  };
}
