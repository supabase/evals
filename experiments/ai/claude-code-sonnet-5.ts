import { defineExperiment } from '@supabase-evals/core';
import { claudeCodeSonnet5 } from '../presets.js';

export default defineExperiment({
  suite: ['benchmark'],
  ...claudeCodeSonnet5,
});
