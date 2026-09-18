import { defineExperiment } from '@supabase-evals/core';
import { opencodeKimiK3 } from '../presets.js';

export default defineExperiment({
  suite: ['benchmark'],
  ...opencodeKimiK3,
});
