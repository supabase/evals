import { defineExperiment } from '@supabase-evals/core';
import { claudeCodeSonnet5 } from '../presets.ts';

export default defineExperiment({
  ...claudeCodeSonnet5,
  suite: ['no-skills'],
  skills: [],
});
