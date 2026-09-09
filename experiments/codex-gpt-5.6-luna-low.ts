import {
  codexAgent,
  defineExperiment,
  platformLiteRuntime,
  supabaseMcpServer,
} from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';

// Cheap regression loadout candidate. Same model as codex-gpt-5.6-luna at low effort.
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
  skills: ['supabase', 'supabase-postgres-best-practices'],
});
