import {
  defineExperiment,
  opencodeAgent,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

// OpenCode driving Moonshot's Kimi K3. Runs in both modes (see
// opencode-claude-sonnet-5.ts); the `moonshotai/` prefix selects the
// MOONSHOT_API_KEY credential.
export default defineExperiment({
  agent: opencodeAgent({
    model: "moonshotai/kimi-k3",
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
