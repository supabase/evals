import { defineExperiment } from '@supabase-evals/core';
import { claudeCodeSonnet5 } from '../presets.js';

export default defineExperiment({
  suite: ['no-skills'],
  ...claudeCodeSonnet5,
  skills: [],
});
