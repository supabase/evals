import { createOpenAI } from '@ai-sdk/openai';
import {
  aiSdkAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';

// Routed through OpenRouter (OpenAI-compatible endpoint) — same transport as
// experiments/openai-gpt-5.6.ts. OpenRouter namespaces model ids by provider,
// hence "openai/...". Chosen for the trigger suite after OpenRouter's account
// data policy blocked the anthropic/claude-sonnet-5 route.
const model = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
})('openai/gpt-5.6-terra');

// Skill-trigger suite on the OpenAI model: measures whether the agent loads the
// right skills from their descriptions alone (clean run). Tools mode, in-process
// ai-sdk agent (no sandbox) — the scorer is deterministic
// (`createSkillTriggerScorer` in each EVAL.ts) and only reads which skills
// loaded, so no localStack/runtime DB surface is exercised.
export default defineExperiment({
  suite: ['trigger'],
  agent: aiSdkAgent({
    model,
    providerOptions: {
      openai: {
        textVerbosity: 'low',
      },
    },
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  skills: ['supabase', 'supabase-postgres-best-practices'],
});
