import { openai } from "@ai-sdk/openai";
import { aiSdkAgent, defineExperiment, executorMcpServer, platformLiteRuntime } from "@supabase-evals/core";

export default defineExperiment({
  agent: aiSdkAgent({
    model: openai("gpt-5.4-mini"),
    providerOptions: {
      openai: {
        reasoningEffort: "low",
        textVerbosity: "low",
      },
    },
  }),
  runtime: platformLiteRuntime({
    mcpServers: [executorMcpServer()],
  }),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
