import { openai } from '@ai-sdk/openai';
import {
  aiSdkAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
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
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ['supabase', 'supabase-postgres-best-practices'],
});
