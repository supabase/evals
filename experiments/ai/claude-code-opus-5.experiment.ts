import { defineExperiment } from '@supabase-evals/core';
import { claudeCodeOpus5 } from '../presets.js';

export default defineExperiment({
  ...claudeCodeOpus5,
  suite: ['benchmark'],
});
