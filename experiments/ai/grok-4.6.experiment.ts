import { defineExperiment } from '@supabase-evals/core';
import { grok46 } from '../presets.ts';

export default defineExperiment({
  ...grok46,
  suite: ['benchmark'],
});
