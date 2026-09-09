import {
  codexAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

// Same as codex-gpt-5.6-luna-low but with no skills, to measure skills' impact.
export default defineExperiment({
  suite: ['regression'],
  agent: codexAgent({
    model: 'gpt-5.6-luna',
    reasoningEffort: 'low',
  }),
  runtime: platformLiteRuntime({
    mcpServers: [supabaseMcpServer()],
  }),
  localStack: localStackRuntime(),
  skills: [],
  // Evals that override `skills: []` already run under the baseline experiment. Skip them from running again here.
  skipEval: (ev) => ev.metadata.skills?.length === 0,
});
