import type { ExperimentConfig } from "../apps/framework/harness/types.js";

const config: ExperimentConfig = {
  agent: "ai-sdk",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  skills: ["supabase", "supabase-postgres-best-practices"],
  mode: "mcp",
  runs: 4,
  earlyExit: true,
  timeoutSec: 720,
};

export default config;
