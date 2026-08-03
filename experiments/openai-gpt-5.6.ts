import { createOpenAI } from '@ai-sdk/openai';
import {
  aiSdkAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

// Routed through OpenRouter (BYOK'd with the OpenAI key) for the gpt-5.6-terra
// discount — OpenRouter namespaces model ids by provider, hence "openai/...".
const model = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
})('openai/gpt-5.6-terra');

export default defineExperiment({
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
  localStack: localStackRuntime(),
  skills: ['supabase', 'supabase-postgres-best-practices'],
});
