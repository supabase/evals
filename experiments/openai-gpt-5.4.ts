import type { ExperimentConfig } from "../apps/framework/harness/types.js";

const config: ExperimentConfig = {
  agent: "ai-sdk",
  provider: "openai",
  model: "gpt-5.4",
  providerOptions: {
    reasoningEffort: "medium",
    textVerbosity: "low",
  },
  skills: ["supabase", "supabase-postgres-best-practices"],
  mode: "mcp",
  earlyExit: true,
  timeoutSec: 720,
};

export default config;
