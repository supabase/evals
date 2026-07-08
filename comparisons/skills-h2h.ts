import { defineComparison } from "@supabase-evals/core";
import gpt54mini from "../agents/openai-gpt-5.4-mini.js";
import gpt55 from "../agents/openai-gpt-5.5.js";
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
  name: "skills-h2h",
  dataset: { scenarios: ["build-cli-002-declarative-schema"] },
  agents: [
    { name: "gpt-5.5", agent: gpt55 },
    { name: "gpt-5.4-mini", agent: gpt54mini },
  ],
  environments: [
    { name: "control", environment: baseline, control: true },
    { name: "with-supabase-skill", environment: withSkill },
  ],
});
