import {
  codexAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

// Codex runs in both modes, like Claude Code: `runtime` drives tools-mode evals
// (the runner writes its MCP servers into ~/.codex/config.toml against platform-
// lite) and `localStack` drives local-stack evals. Which mode an eval uses is a
// property of the eval (interface/local dir), not the agent.
export default defineExperiment({
  agent: codexAgent({
    model: "gpt-5.5",
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
