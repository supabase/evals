import { openai } from "@ai-sdk/openai";
import { aiSdkAgent, defineExperiment, platformLiteRuntime, supabaseMcpServer } from "@supabase-evals/core";

export default defineExperiment({
  agent: aiSdkAgent({
    model: openai("gpt-5.4-nano"),
    providerOptions: {
      openai: {
        reasoningEffort: "low",
        textVerbosity: "low",
      },
    },
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
