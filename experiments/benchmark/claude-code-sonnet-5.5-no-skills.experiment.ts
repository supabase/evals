import { defineExperiment } from '@supabase-evals/core';
import { claudeCodeSonnet55 } from '../presets.js';

export default defineExperiment({
  ...claudeCodeSonnet55,
  skills: [],
});
