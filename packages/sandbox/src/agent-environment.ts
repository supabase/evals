/**
 * The agent's execution environment — composed from toggleable pieces.
 *
 * Both eval modes give a CLI agent the *same* sandbox: the Supabase image (node,
 * git, the Supabase CLI, the skills CLI), the agent's full tooling, and any
 * requested skills installed for it to read. The ONE thing that differs is the
 * Supabase local stack:
 *
 *   - `localStack` set    → local-stack mode: host networking + `supabase start`.
 *   - `localStack` omitted → tools mode: no stack; the eval's tools come from MCP.
 *
 * `localStackRuntime` and `createBareSandbox` are both just configurations of
 * this builder, so adding/removing an environment component happens in one place.
 */

import type { SkillSource } from '@supabase-evals/core';
import { DockerSandbox } from './docker-sandbox.js';
import {
  ensureSupabaseSandboxImage,
  setupSupabaseSandbox,
} from './supabase.js';
import { installSkills, type SkillEntry } from './skills.js';

/** Supabase-local-stack component of the environment. */
export interface LocalStackSetup {
  /** Services to start; others are excluded to keep boots fast. */
  includeServices?: readonly string[];
  /** Whether the stack is already running when the agent starts (default true). */
  projectRunning?: boolean;
  /** Link the CLI to a mocked hosted project (platform-lite) at this host port. */
  hosted?: { port: number; pgPort?: number; ref: string; accessToken: string };
}

export interface AgentEnvironmentOptions {
  /** Supabase CLI version baked into the sandbox image. */
  cliVersion?: string;
  /** Host directory whose contents seed the workspace. */
  localDir?: string;
  /** Skills to install into the sandbox (the agent reads them with its file tools). */
  skills?: readonly SkillSource[];
  /**
   * Run the Supabase local stack. Present → local-stack mode; omitted → tools
   * mode. This is the only difference between the two environments.
   */
  localStack?: LocalStackSetup;
}

export interface AgentEnvironment {
  /** The created sandbox (the CLI agent's working directory + tools). */
  sandbox: DockerSandbox;
  /** Skills installed in the sandbox, for the discovery prompt. */
  skills: SkillEntry[];
  /** Stop the sandbox. */
  close(): Promise<void>;
}

export async function createAgentEnvironment(
  options: AgentEnvironmentOptions = {}
): Promise<AgentEnvironment> {
  // Same base image for both modes — it carries the common agent tooling (node,
  // git, the skills CLI). The Supabase CLI is NOT in it; it's installed by
  // setupSupabaseSandbox only in local-stack mode. That + starting the stack is
  // the entire mode difference.
  const image = await ensureSupabaseSandboxImage();
  const sandbox = await DockerSandbox.create({
    image,
    // The local stack needs host networking so the Supabase CLI can health-check
    // the ports `supabase start` publishes on 127.0.0.1. Tools mode runs no
    // stack and instead reaches host-side platform-lite over the default bridge
    // via host.docker.internal — so bridge there.
    network: options.localStack ? 'host' : undefined,
  });
  try {
    if (options.localStack) {
      await setupSupabaseSandbox(sandbox, {
        cliVersion: options.cliVersion,
        includeServices: options.localStack.includeServices,
        localDir: options.localDir,
        projectRunning: options.localStack.projectRunning,
        hosted: options.localStack.hosted,
      });
    } else if (options.localDir) {
      await sandbox.copyToContainer(options.localDir, sandbox.workdir);
    }
    // Skills are installed in both modes; the agent reads SKILL.md with its file tools.
    const skills = await installSkills(sandbox, options.skills ?? []);
    return { sandbox, skills, close: () => sandbox.stop() };
  } catch (err) {
    await sandbox.stop();
    throw err;
  }
}
