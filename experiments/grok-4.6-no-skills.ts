import {
  defineExperiment,
  grokAgent,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

// Same as grok-4.6 but with no skills, to measure skills' impact.
export default defineExperiment({
  suite: ['no-skills'],
  agent: grokAgent({
    model: 'grok-4.6',
    reasoningEffort: 'high',
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: [],
});
