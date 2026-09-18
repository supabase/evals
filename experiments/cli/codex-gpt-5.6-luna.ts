import { defineExperiment } from '@supabase-evals/core';
import { baselineExperiment } from '../presets.js';

export default defineExperiment({
  suite: ['cli'],
  ...baselineExperiment,
});
