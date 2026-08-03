import { anthropic } from '@ai-sdk/anthropic';
import {
  aiSdkAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';

// Same as trigger-claude-sonnet-5 but with no skills available, so the
// trigger-report correlation can contrast P(pass|loaded) vs P(pass|not
// loaded) per skill. Runs against the same 97 trigger evals; with no skills the
// agent cannot load any, so every expected-skill check is a "missed" — that
// baseline is exactly the signal the report needs.
export default defineExperiment({
  suite: ['trigger'],
  agent: aiSdkAgent({
    model: anthropic('claude-sonnet-5'),
    providerOptions: {
      anthropic: { effort: 'max' },
    },
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  skills: [],
});
