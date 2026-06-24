import {
  defineExperiment,
  opencodeAgent,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

// OpenCode driving Google's latest Gemini Flash (cheapest tier). Runs in both
// modes (see opencode-claude-sonnet-5.ts); the `google/` prefix selects the
// GOOGLE_GENERATIVE_AI_API_KEY credential (Google AI Studio, not Vertex).
// `gemini-flash-latest` tracks the newest Flash — the only Gemini Flash id that
// the AI-Studio key serves end-to-end (pinned 2.5/3.x-flash ids returned no
// output via opencode 1.15.7).
export default defineExperiment({
  agent: opencodeAgent({
    model: "google/gemini-flash-latest",
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
