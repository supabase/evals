import type { ExperimentConfig } from "../harness/types.js";

const config: ExperimentConfig = {
  agent: "ai-sdk",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  providerOptions: {
    effort: "max",
  },
  skills: ["supabase", "supabase-postgres-best-practices"],
  mode: "mcp",
  runs: 1,
  earlyExit: true,
  timeoutSec: 720,
};

export default config;
