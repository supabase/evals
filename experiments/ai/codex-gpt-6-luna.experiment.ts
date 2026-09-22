import { defineExperiment } from '@supabase-evals/core';
import { codexGpt6Luna } from '../presets.js';

export default defineExperiment({
  ...codexGpt6Luna,
  suite: ['benchmark', 'regression'],
});
