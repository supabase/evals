import { defineExperiment } from '@supabase-evals/core';
import { hostedCliRuntime } from '@supabase-evals/sandbox';
import spark from './codex-gpt-6-luna-adapted.experiment.js';

export default defineExperiment({
  ...spark,
  localStack: hostedCliRuntime({
    mcpFeatures: ['docs', 'account', 'database', 'development'],
  }),
  skipEval: (ev) =>
    ev.id !== 'build-database-001-migrate-postgres-to-supabase-spark',
});
