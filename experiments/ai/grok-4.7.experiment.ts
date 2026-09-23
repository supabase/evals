import { defineExperiment } from '@supabase-evals/core';
import { grok47 } from '../presets.js';

export default defineExperiment({
  ...grok47,
  suite: ['benchmark'],
});
