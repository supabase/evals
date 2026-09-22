import { defineExperiment } from '@supabase-evals/core';
import { codexGpt56Luna } from '../presets.js';

export default defineExperiment({
  ...codexGpt56Luna,
  // cli: the pinned-CLI baseline column for CLI-team evals.
  suite: ['benchmark', 'regression', 'cli'],
});
