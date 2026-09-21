import { defineExperiment } from '@supabase-evals/core';
import { codexGpt56Luna } from '../presets.ts';

export default defineExperiment({
  ...codexGpt56Luna,
  suite: ['no-skills', 'regression', 'docs'],
  skills: [],
  // Evals that override `skills: []` already run under the baseline experiment.
  skipEval: (ev) => ev.metadata.skills?.length === 0,
});
