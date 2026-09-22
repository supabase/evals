import { defineExperiment } from '@supabase-evals/core';
import { grok46 } from '../presets.js';

export default defineExperiment({
  ...grok46,
  suite: ['benchmark'],
});
