import type { ExperimentConfig } from "../apps/framework/harness/types.js";

const config: ExperimentConfig = {
  agent: "ai-sdk",
  provider: "anthropic",
  model: "claude-opus-4-7",
  providerOptions: {
    effort: "max",
  },
  skills: ["supabase", "supabase-postgres-best-practices"],
  mode: "mcp",
  earlyExit: true,
  timeoutSec: 720,
};

export default config;
