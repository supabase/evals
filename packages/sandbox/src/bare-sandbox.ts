import type { AgentSandbox } from "@supabase-evals/core";
import { DockerSandbox } from "./docker-sandbox.js";
import { toAgentSandbox } from "./local-stack-runtime.js";

export interface BareSandboxHandle {
  sandbox: AgentSandbox;
  close(): Promise<void>;
}

/**
 * A minimal execution substrate for CLI agents in tools mode: a bare Node
 * container (no Supabase CLI, no local stack, no NET_ADMIN), just somewhere to
 * install and run the agent binary. It reaches host-side platform-lite via
 * `host.docker.internal` (DockerSandbox adds that host mapping), so the agent's
 * in-container MCP servers can talk to the mocked platform.
 *
 * Distinct from `localStackRuntime`, which boots the full Supabase stack as the
 * agent's *tool surface*; here the sandbox is purely the agent's runtime and the
 * eval's tools come from MCP.
 */
export async function createBareSandbox(): Promise<BareSandboxHandle> {
  const sandbox = await DockerSandbox.create();
  return {
    sandbox: toAgentSandbox(sandbox),
    close: () => sandbox.stop(),
  };
}
