import type { ExperimentConfig } from "../harness/types.js";

const config: ExperimentConfig = {
  agent: "ai-sdk",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  // Skills installed from supabase/agent-skills (see skills/MANIFEST.md).
  defaultSkills: ["supabase", "supabase-postgres-best-practices"],
  // Default mgmt-api endpoints the agent can call. Per-eval `tools.json`
  // narrows this further.
  defaultTools: ["database.query", "logs.all"],
  runs: 4,
  earlyExit: true,
  timeoutSec: 720,
};

export default config;
