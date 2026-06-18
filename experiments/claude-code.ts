import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

// Claude Code is a CLI agent: it runs its own harness (Read/Write/Bash/Edit +
// MCP) inside the local-stack sandbox. It only runs against local-stack evals
// (interface: cli or a local/ workspace); tools-mode evals are skipped. The
// `runtime` below is required by the config shape but unused for those.
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
