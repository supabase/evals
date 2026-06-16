import { anthropic } from "@ai-sdk/anthropic";
import { aiSdkAgent, defineExperiment, executorMcpServer, platformLiteRuntime } from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

export default defineExperiment({
  agent: aiSdkAgent({
    model: anthropic("claude-sonnet-4-6"),
    providerOptions: {
      anthropic: { effort: "max" },
    },
  }),
  runtime: platformLiteRuntime({
    mcpServers: [executorMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
