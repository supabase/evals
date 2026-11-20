import { defineExperiment } from '@supabase-evals/core';
import { claudeCodeSonnet55 } from '../presets.js';
import { supabaseShInstructions } from '../supabase-sh.js';

export default defineExperiment({
  ...claudeCodeSonnet55,
  skills: [],
  instructions: supabaseShInstructions,
});
