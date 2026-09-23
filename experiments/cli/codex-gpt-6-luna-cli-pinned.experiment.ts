import { defineExperiment } from '@supabase-evals/core';
import { codexGpt6Luna } from '../presets.js';
import { skipUnlessCli } from './lib/skip.js';

export default defineExperiment({
  ...codexGpt6Luna,
  suite: ['cli'],
  skipEval: skipUnlessCli,
});
