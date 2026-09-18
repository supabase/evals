import {
  codexAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import {
  dockerAwareLocalStackRuntime,
  skipUnlessCli,
} from './_lib/docker-aware-local-stack.js';

export default defineExperiment({
  suite: ['cli'],
  agent: codexAgent({
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: dockerAwareLocalStackRuntime({ channel: 'beta' }),
  skills: ['supabase', 'supabase-postgres-best-practices'],
  skipEval: skipUnlessCli,
});
