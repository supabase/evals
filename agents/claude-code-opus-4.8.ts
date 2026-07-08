import { claudeCodeAgent, defineAgent } from "@supabase-evals/core";

/** The "who": Claude Code on Opus 4.8. Reusable across any environment. */
export default defineAgent(
  claudeCodeAgent({ model: "claude-opus-4-8", reasoningEffort: "high" }),
);
