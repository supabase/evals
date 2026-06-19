import type { AgentSandbox } from "@supabase-evals/core";
import { DockerSandbox, type DockerSandboxOptions } from "./docker-sandbox.js";
import { toAgentSandbox } from "./local-stack-runtime.js";

export interface BareSandboxHandle {
  sandbox: AgentSandbox;
  close(): Promise<void>;
}

/**
 * A minimal execution substrate for CLI agents in tools mode: a bare Node
 * container (no Supabase CLI, no local stack), just somewhere to install and
 * run the agent binary. The eval's tools come from MCP, not the Supabase CLI.
 *
 * This is a thin composition of two primitives we already have —
 * `DockerSandbox.create` + `toAgentSandbox` — and reuses the `AgentSandbox`
 * adapter `localStackRuntime` also uses. The difference from `localStackRuntime`
 * is purely that it skips the expensive Supabase provisioning (image build +
 * `supabase start`); pass `DockerSandboxOptions` through to tune the container
 * (image, timeout, network).
 *
 * The container's MCP servers reach host-side platform-lite via
 * `host.docker.internal` (DockerSandbox always adds that host mapping).
 */
export async function createBareSandbox(
  options: DockerSandboxOptions = {},
): Promise<BareSandboxHandle> {
  const sandbox = await DockerSandbox.create(options);
  return {
    sandbox: toAgentSandbox(sandbox),
    close: () => sandbox.stop(),
  };
}
