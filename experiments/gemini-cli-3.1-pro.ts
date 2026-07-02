import {
  defineExperiment,
  geminiCliAgent,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

// Google's Gemini CLI driving Gemini 3.1 Pro. Like Claude Code / Codex it runs
// in both modes: `runtime` supplies the MCP servers for tools-mode evals
// (written into ~/.gemini/settings.json) and `localStack` drives local-stack
// evals. Which mode an eval uses is a property of the eval, not the agent.
export default defineExperiment({
  suite: ["benchmark"],
  agent: geminiCliAgent({
    model: "gemini-3.1-pro-preview",
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
