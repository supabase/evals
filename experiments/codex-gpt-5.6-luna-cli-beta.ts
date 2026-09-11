import {
  codexAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { dockerAwareLocalStackRuntime } from './_lib/docker-aware-local-stack.js';

export default defineExperiment({
  suite: ['regression'],
  agent: codexAgent({
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: dockerAwareLocalStackRuntime({ channel: 'beta' }),
  skills: ['supabase', 'supabase-postgres-best-practices'],
  // Only CLI evals exercise the installed CLI version; hosted evals seed .temp
  // version files pinned to the baseline CLI's service versions.
  skipEval: (ev) =>
    ev.metadata.interface !== 'cli' || ev.metadata.hostedProject === true,
});
