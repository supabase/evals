import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

// Claude Code on Haiku. See experiments/claude-code-sonnet-4.6.ts for the
// CLI-agent notes (runs in both modes: full sandbox for local-stack evals, bare
// sandbox + MCP for tools-mode evals).
export default defineExperiment({
  agent: claudeCodeAgent({
    model: "claude-haiku-4-5",
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
