import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

// Same as claude-code-sonnet-5 but with no skills, to measure skills' impact.
export default defineExperiment({
  suite: ['no-skills', 'regression'],
  agent: claudeCodeAgent({
    model: 'claude-sonnet-5',
    reasoningEffort: 'high',
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: [],
  // Evals that override `skills: []` already run under the baseline experiment. Skip them from running again here.
  skipEval: (ev) => ev.metadata.skills?.length === 0,
});
