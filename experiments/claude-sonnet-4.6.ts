import { anthropic } from "@ai-sdk/anthropic";
import { aiSdkAgent, defineExperiment, platformLiteRuntime, supabaseMcpServer } from "@supabase-evals/core";

export default defineExperiment({
  agent: aiSdkAgent({
    model: anthropic("claude-sonnet-4-6"),
    providerOptions: {
      anthropic: { effort: "max" },
    },
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
