// Vercel AI Gateway variant of codex-gpt-5.4-mini: same agent and model,
// routed through the gateway instead of the OpenAI API. No `suite`, so it
// only runs when named explicitly (--experiment gateway-codex-gpt-5.4-mini).
import {
  codexAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

export default defineExperiment({
  agent: codexAgent({
    model: "openai/gpt-5.4-mini",
    reasoningEffort: "medium",
    gateway: true,
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
