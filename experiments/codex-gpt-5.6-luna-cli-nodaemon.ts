import {
  codexAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { dockerAwareLocalStackRuntime } from './_lib/docker-aware-local-stack.js';

const DOCKERLESS_ARM_EVALS = new Set(['build-database-002-stack-lifecycle']);

export default defineExperiment({
  suite: ['regression'],
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
    docker: 'no-daemon',
  }),
  skills: ['supabase', 'supabase-postgres-best-practices'],
  // These arms exist to compare the stack-lifecycle scenario across forced
  // environments; widen deliberately rather than by capability.
  skipEval: (ev) => !DOCKERLESS_ARM_EVALS.has(ev.id),
});
