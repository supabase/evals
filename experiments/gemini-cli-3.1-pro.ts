import {
  defineExperiment,
  geminiCliAgent,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

// Google's Gemini CLI driving Gemini 3.1 Pro — Google's comparable to GPT-5.5
// and Opus 4.8. Like Claude Code / Codex it runs in both modes: `runtime`
// supplies the MCP servers for tools-mode evals (written into
// ~/.gemini/settings.json) and `localStack` drives local-stack evals. Which
// mode an eval uses is a property of the eval, not the agent.
export default defineExperiment({
  suite: ["benchmark"],
  agent: geminiCliAgent({
    model: "gemini-3.1-pro-preview",
    // gemini-3.1-pro-preview thinks at `high` by default (inherited from
    // chat-base-3); gemini-cli has no flag to change it. Recorded for parity
    // with the other high-effort benchmark agents (Opus 4.8).
    reasoningEffort: "high",
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
