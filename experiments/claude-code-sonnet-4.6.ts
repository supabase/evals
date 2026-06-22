import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

// Claude Code is a CLI agent: it runs its own harness (Read/Write/Bash/Edit +
// MCP) inside a sandbox, in BOTH eval modes. Local-stack evals (interface: cli
// or a local/ workspace) get the full sandbox — the Supabase CLI plus a running
// local stack. Tools-mode evals get a bare sandbox (same image, no stack) where
// the eval's tools come from the `runtime` MCP servers (reached host-side via
// host.docker.internal). The running stack + the CLI is the only mode difference.
export default defineExperiment({
  agent: claudeCodeAgent({
    model: "claude-sonnet-4-6",
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
