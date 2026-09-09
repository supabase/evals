import {
  claudeCodeAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

// Same as claude-code-haiku-4.5 but with no skills, to measure skills' impact.
export default defineExperiment({
  suite: ['regression'],
  agent: claudeCodeAgent({
    model: 'claude-haiku-4-5',
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: [],
  // Evals that override `skills: []` already run under the baseline experiment. Skip them from running again here.
  skipEval: (ev) => ev.metadata.skills?.length === 0,
});
