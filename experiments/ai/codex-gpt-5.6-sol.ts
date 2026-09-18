import { defineExperiment } from '@supabase-evals/core';
import { codexGpt56Sol } from '../presets.js';

export default defineExperiment({
  suite: ['benchmark'],
  ...codexGpt56Sol,
});
