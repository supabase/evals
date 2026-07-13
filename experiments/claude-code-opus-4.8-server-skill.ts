import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

// "server" suite: exercises the build-functions-006 (mandated @supabase/server)
// scenario. @supabase/server validates only the new API keys and needs the edge
// runtime to expose SUPABASE_SECRET_KEYS/PUBLISHABLE_KEYS/JWKS, which the default
// pinned CLI (2.67.1) does not inject — so these experiments pin a newer CLI.
// This is the WITH-server-skill arm (the `supabase-server` skill is installed).
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
  skills: ["supabase", "supabase-postgres-best-practices", "supabase-server"],
});
