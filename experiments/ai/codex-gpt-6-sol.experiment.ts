import { defineExperiment } from '@supabase-evals/core';
import { codexGpt6Sol } from '../presets.js';

export default defineExperiment({
  ...codexGpt6Sol,
  suite: ['benchmark'],
});
