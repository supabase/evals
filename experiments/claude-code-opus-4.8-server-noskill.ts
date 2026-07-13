import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

// "server" suite, WITHOUT-server-skill arm: same newer CLI as the -server-skill
// variant, but only the base Supabase skills are installed (no `supabase-server`
// skill). Pairs with claude-code-opus-4.8-server-skill to measure how much the
// package's own skill helps an agent use a brand-new, low-training-signal API.
export default defineExperiment({
  suite: ["server"],
  agent: claudeCodeAgent({
    model: "claude-opus-4-8",
    reasoningEffort: "high",
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime({ cliVersion: "2.109.1" }),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
