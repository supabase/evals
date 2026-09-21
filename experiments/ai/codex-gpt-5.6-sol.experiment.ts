import { defineExperiment } from '@supabase-evals/core';
import { codexGpt56Sol } from '../presets.ts';

export default defineExperiment({
  ...codexGpt56Sol,
  suite: ['benchmark'],
});
