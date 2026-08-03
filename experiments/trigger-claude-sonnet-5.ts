import { anthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import {
  aiSdkAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';

// ponytail: route through OpenRouter's OpenAI-compatible endpoint when
// OPENROUTER_API_KEY is set (billing fallback for local runs), else call
// Anthropic directly. Same model either way — only the transport differs.
const model = process.env.OPENROUTER_API_KEY
  ? createOpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
    })('anthropic/claude-sonnet-5')
  : anthropic('claude-sonnet-5');

// Skill-trigger suite: measures whether the agent loads the right skills from
// their descriptions alone (clean run) and under a noisy context window
// (`--noisy-context`). Tools mode, in-process ai-sdk agent (no sandbox) — the
// scorer is deterministic (`createSkillTriggerScorer` in each EVAL.ts) and only
// reads which skills loaded, so no localStack/runtime DB surface is exercised.
export default defineExperiment({
  suite: ['trigger'],
  agent: aiSdkAgent({
    model,
    providerOptions: {
      anthropic: { effort: 'max' },
    },
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  skills: ['supabase', 'supabase-postgres-best-practices'],
});
