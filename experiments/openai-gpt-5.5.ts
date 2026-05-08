import { openai } from "@ai-sdk/openai";
import { aiSdkAgent, defineExperiment, platformLiteRuntime, supabaseMcpServer } from "@supabase-evals/core";

export default defineExperiment({
  agent: aiSdkAgent({
    model: openai("gpt-5.5"),
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
        textVerbosity: "low",
      },
    },
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
