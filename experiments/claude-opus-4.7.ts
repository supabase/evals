import { anthropic } from "@ai-sdk/anthropic";
import { aiSdkAgent, defineExperiment, platformLiteRuntime, supabaseMcpServer } from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

export default defineExperiment({
  agent: aiSdkAgent({
    model: anthropic("claude-opus-4-7"),
    providerOptions: {
      anthropic: { effort: "max" },
    },
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
