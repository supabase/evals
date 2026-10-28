import { defineExperiment } from '@supabase-evals/core';
import { codexGpt61Sol } from '../presets.js';

export default defineExperiment({
  ...codexGpt61Sol,
  skills: [],
});
