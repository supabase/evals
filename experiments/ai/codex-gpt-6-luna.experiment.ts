import { defineExperiment } from '@supabase-evals/core';
import { codexGpt6Luna } from '../presets.js';

export default defineExperiment({
  ...codexGpt6Luna,
  // cli: the pinned-CLI baseline column for CLI-team evals.
  suite: ['benchmark', 'regression', 'cli'],
});
