import { defineComparison } from "@supabase-evals/core";
import opus from "../agents/claude-code-opus-4.8.js";
import sonnet from "../agents/claude-sonnet-5.js";
import gpt55 from "../agents/openai-gpt-5.5.js";
import gpt54mini from "../agents/openai-gpt-5.4-mini.js";
import environment from "../environments/supabase-mcp-skill.js";

/**
 * The benchmark — varies the **agent** with no control level, so it ranks
 * models as a leaderboard rather than diffing them. The environment is held
 * fixed (a single level), so every model runs with the same tools + skill.
 */
export default defineComparison({
  name: "benchmark",
  dataset: { suite: ["benchmark"] },
  agents: [
    { name: "claude-code-opus-4.8", agent: opus },
    { name: "claude-sonnet-5", agent: sonnet },
    { name: "openai-gpt-5.5", agent: gpt55 },
    { name: "openai-gpt-5.4-mini", agent: gpt54mini },
  ],
  environments: [{ name: "supabase-mcp-skill", environment }],
});
