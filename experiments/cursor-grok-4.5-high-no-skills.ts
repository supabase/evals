import {
  cursorAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

// Same as cursor-grok-4.5-high but with no skills, to measure skills' impact.
export default defineExperiment({
  suite: ['no-skills', 'regression'],
  agent: cursorAgent({
    model: 'cursor-grok-4.5-high',
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: [],
  // Evals that override `skills: []` already run under the baseline experiment. Skip them from running again here.
  skipEval: (ev) => ev.metadata.skills?.length === 0,
});
