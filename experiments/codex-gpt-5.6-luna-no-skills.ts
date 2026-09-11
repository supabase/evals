import {
  codexAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';
import { requiresDockerlessSandbox } from './_lib/sandbox-environment.js';

export default defineExperiment({
  suite: ['no-skills', 'regression'],
  agent: codexAgent({
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: [],
  // Evals that override `skills: []` already run under the baseline experiment. Skip them from running again here.
  // The stock sandbox always has a working Docker; docker-less evals run under the -cli-* experiments.
  skipEval: (ev) =>
    ev.metadata.skills?.length === 0 || requiresDockerlessSandbox(ev.id),
});
