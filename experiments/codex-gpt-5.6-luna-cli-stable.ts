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
  // Currently equal to the pin (npm `latest` == SUPABASE_CLI_VERSION); kept
  // as drift insurance between pin bumps.
  localStack: dockerAwareLocalStackRuntime({ channel: 'stable' }),
  skills: ['supabase', 'supabase-postgres-best-practices'],
  skipEval: skipUnlessCli,
});
