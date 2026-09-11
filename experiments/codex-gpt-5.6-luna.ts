import {
  codexAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';
import { requiresDockerlessSandbox } from './_lib/sandbox-environment.js';

export default defineExperiment({
  suite: ['benchmark', 'regression'],
  agent: codexAgent({
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: ['supabase', 'supabase-postgres-best-practices'],
  // The stock sandbox always has a working Docker; docker-less evals run under the -cli-* experiments.
  skipEval: (ev) => requiresDockerlessSandbox(ev.id),
});
