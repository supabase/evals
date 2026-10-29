import { defineExperiment } from '@supabase-evals/core';
import { museSpark13 } from '../presets.js';

export default defineExperiment({
  ...museSpark13,
  suite: ['no-skills'],
  skills: [],
});
