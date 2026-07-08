import { codexAgent, defineAgent } from "@supabase-evals/core";

/** The "who": GPT-5.5 via the Codex CLI. Reusable across any environment. */
export default defineAgent(
  codexAgent({ model: "gpt-5.5", reasoningEffort: "high" }),
);
