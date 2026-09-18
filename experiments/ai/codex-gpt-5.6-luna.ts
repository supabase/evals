import { defineExperiment } from '@supabase-evals/core';
import { codexGpt56Luna } from '../presets.js';

export default defineExperiment({
  suite: ['benchmark', 'regression'],
  ...codexGpt56Luna,
});
