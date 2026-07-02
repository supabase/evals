import {
  cursorCliAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from "@supabase-evals/core";
import { localStackRuntime } from "@supabase-evals/sandbox";

// Cursor's CLI (`cursor-agent`) driving Composer 2.5 (Cursor's own model, fast
// mode / Max mode off). Like Claude Code / Codex it runs in both modes:
// `runtime` supplies the MCP servers for tools-mode evals (written into
// ~/.cursor/mcp.json) and `localStack` drives local-stack evals. Which mode an
// eval uses is a property of the eval, not the agent.
export default defineExperiment({
  suite: ["benchmark"],
  agent: cursorCliAgent({
    model: "composer-2.5",
    // Max mode is off (the default), so no reasoningEffort is recorded. Cursor
    // has no low/medium/high dial — set reasoningEffort: "max" only to record
    // that Max mode is on.
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ["supabase", "supabase-postgres-best-practices"],
});
