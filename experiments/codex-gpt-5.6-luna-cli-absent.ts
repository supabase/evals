import {
  codexAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { dockerAwareLocalStackRuntime } from './_lib/docker-aware-local-stack.js';

export default defineExperiment({
  suite: ['cli'],
  agent: codexAgent({
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  // beta: the Docker-less path only exists in the managed stack, which ships in beta.
  localStack: dockerAwareLocalStackRuntime({
    channel: 'beta',
    docker: 'absent',
  }),
  skills: ['supabase', 'supabase-postgres-best-practices'],
  // A Docker-less sandbox can only run evals that declare they don't need Docker.
  skipEval: (ev) => ev.metadata.needsDocker !== false,
});
