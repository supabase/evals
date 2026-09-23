import { defineExperiment } from '@supabase-evals/core';
import { codexGpt6Luna } from '../presets.js';

export default defineExperiment({
  ...codexGpt6Luna,
  suite: ['no-skills', 'regression', 'docs'],
  skills: [],
  // Evals that override `skills: []` already run under the baseline experiment.
  skipEval: (ev) => ev.metadata.skills?.length === 0,
});
