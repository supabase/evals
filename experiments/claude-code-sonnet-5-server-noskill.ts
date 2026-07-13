import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

// "server" suite, WITHOUT-server-skill arm (sonnet-5). Pairs with
// claude-code-sonnet-5-server-skill; base Supabase skills only, no
// `supabase-server` skill.
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
  skills: ["supabase", "supabase-postgres-best-practices"],
});
