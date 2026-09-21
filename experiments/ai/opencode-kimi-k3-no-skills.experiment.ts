import { defineExperiment } from '@supabase-evals/core';
import { opencodeKimiK3 } from '../presets.ts';

export default defineExperiment({
  ...opencodeKimiK3,
  suite: ['no-skills'],
  skills: [],
});
