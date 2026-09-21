import { defineExperiment } from '@supabase-evals/core';
import { codexGpt56Luna } from '../presets.ts';

export default defineExperiment({
  ...codexGpt56Luna,
  suite: ['benchmark', 'regression'],
});
