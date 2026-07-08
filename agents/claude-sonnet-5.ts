import { claudeCodeAgent, defineAgent } from "@supabase-evals/core";

/** The "who": Claude Code on Sonnet 5. Reusable across any environment. */
export default defineAgent(
  claudeCodeAgent({ model: "claude-sonnet-5", reasoningEffort: "high" }),
);
