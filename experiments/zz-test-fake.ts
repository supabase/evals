import { defineExperiment, platformLiteRuntime, supabaseMcpServer } from "@supabase-evals/core";
import type { AgentHarness } from "@supabase-evals/core";

const fakeAgent: AgentHarness = {
  id: "ai-sdk",
  modelId: "fake-model",
  metadata: { agent: "ai-sdk", modelProvider: "anthropic", modelId: "fake-model" },
  assertReady() {},
  async run() {
    return { agentReport: "done", toolCalls: [], transcript: [], steps: 0, stoppedReason: "stop" };
  },
};

export default defineExperiment({
  agent: fakeAgent,
  runtime: platformLiteRuntime({ mcpServers: [supabaseMcpServer()] }),
  skills: [],
});
