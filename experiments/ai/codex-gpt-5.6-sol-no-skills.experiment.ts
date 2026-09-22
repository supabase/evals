import { defineExperiment } from '@supabase-evals/core';
import { codexGpt56Sol } from '../presets.js';

export default defineExperiment({
  ...codexGpt56Sol,
  suite: ['no-skills'],
  skills: [],
});
