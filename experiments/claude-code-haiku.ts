import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

// Claude Code on Haiku. See experiments/claude-code.ts for the CLI-agent notes
// (local-stack only; tools-mode evals are skipped).
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
