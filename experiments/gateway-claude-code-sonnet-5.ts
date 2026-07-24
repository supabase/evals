// Vercel AI Gateway variant of claude-code-sonnet-5: same agent and model,
// routed through the gateway instead of the Anthropic API. No `suite`, so it
// only runs when named explicitly (--experiment gateway-claude-code-sonnet-5).
import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

export default defineExperiment({
  agent: claudeCodeAgent({
    model: "anthropic/claude-sonnet-5",
    reasoningEffort: "high",
    gateway: true,
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
