import { defineComparison } from "@supabase-evals/core";
import gpt5_4_mini from "../agents/openai-gpt-5.4-mini.js";
import gpt5_5 from "../agents/openai-gpt-5.5.js";
import baseline from "../environments/supabase-mcp.js";
import withSkill from "../environments/supabase-mcp-skill.js";

/**
 * Does the `supabase` skill help on the declarative-schema scenario — per model?
 *
 * The **environment** is the treatment: `control` (no skill) is the baseline,
 * `with-supabase-skill` adds it. The **agents** are the scope — the same
 * skill-on/off comparison is repeated for each model, so each gets its own
 * control-vs-skill verdict (not a diff against one global baseline model).
 */
export default defineComparison({
  name: "supabase-skill",
  dataset: { scenarios: ["build-cli-002-declarative-schema"] },
  runs: 1,
  agents: [
    { name: "gpt-5.5", agent: gpt5_5 },
    { name: "gpt-5.4-mini", agent: gpt5_4_mini },
  ],
  environments: [
    { name: "control", environment: baseline, control: true },
    { name: "with-supabase-skill", environment: withSkill },
  ],
});
