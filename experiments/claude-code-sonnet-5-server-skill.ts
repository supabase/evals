import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

// "server" suite, WITH-server-skill arm (sonnet-5). See
// claude-code-opus-4.8-server-skill for why these experiments pin a newer CLI.
export default defineExperiment({
  suite: ["server"],
  agent: claudeCodeAgent({
    model: "claude-sonnet-5",
    reasoningEffort: "high",
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime({ cliVersion: "2.109.1" }),
  skills: ["supabase", "supabase-postgres-best-practices", "supabase-server"],
});
