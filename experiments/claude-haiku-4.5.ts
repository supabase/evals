import { anthropic } from "@ai-sdk/anthropic";
import { aiSdkAgent, defineExperiment, platformLiteRuntime, supabaseMcpServer } from "@supabase-evals/core";

export default defineExperiment({
  agent: aiSdkAgent({
    model: anthropic("claude-haiku-4-5"),
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
