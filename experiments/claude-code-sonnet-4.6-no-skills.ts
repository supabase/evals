import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

// Same as claude-code-sonnet-4.6 but with no skills, to measure skills' impact.
export default defineExperiment({
  suite: ["benchmark"],
  agent: claudeCodeAgent({
    model: "claude-sonnet-4-6",
    reasoningEffort: "high",
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: [],
});
