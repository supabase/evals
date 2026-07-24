// Gemini through the Vercel AI Gateway — a vendor we hold no direct key for;
// the gateway (with the team's BYOK Google key) is what makes this runnable.
// No `suite`, so it only runs when named explicitly
// (--experiment gateway-ai-sdk-gemini-3.6-flash).
import { gateway } from "ai";
import {
  aiSdkAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

export default defineExperiment({
  agent: aiSdkAgent({
    model: gateway("google/gemini-3.6-flash"),
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
