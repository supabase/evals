import { defineExperiment } from '@supabase-evals/core';
import { codexGpt56Luna } from '../presets.js';

export default defineExperiment({
  suite: ['no-skills', 'regression', 'docs'],
  ...codexGpt56Luna,
  skills: [],
  // Per-eval `skills: []` already runs under this baseline.
  skipEval: (ev) => ev.metadata.skills?.length === 0,
});
