import { defineExperiment } from '@supabase-evals/core';
import { claudeCodeOpus5 } from '../presets.js';

export default defineExperiment({
  suite: ['benchmark'],
  ...claudeCodeOpus5,
});
