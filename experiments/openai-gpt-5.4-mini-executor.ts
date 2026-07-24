import { openai } from '@ai-sdk/openai';
import {
  aiSdkAgent,
  defineExperiment,
  executorMcpServer,
  platformLiteRuntime,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

export default defineExperiment({
  agent: aiSdkAgent({
    model: openai('gpt-5.4-mini'),
    providerOptions: {
      openai: {
        reasoningEffort: 'low',
        textVerbosity: 'low',
      },
    },
  }),
  runtime: platformLiteRuntime({
    mcpServers: [executorMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ['supabase', 'supabase-postgres-best-practices'],
});
