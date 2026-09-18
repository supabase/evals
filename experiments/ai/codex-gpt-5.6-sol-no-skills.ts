import { defineExperiment } from '@supabase-evals/core';
import { codexGpt56Sol } from '../presets.js';

export default defineExperiment({
  suite: ['no-skills'],
  ...codexGpt56Sol,
  skills: [],
});
