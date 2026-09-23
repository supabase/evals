import { defineExperiment } from '@supabase-evals/core';
import { claudeCodeOpus55 } from '../presets.js';

export default defineExperiment({
  ...claudeCodeOpus55,
  suite: ['no-skills'],
  skills: [],
});
