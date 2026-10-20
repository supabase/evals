import { defineExperiment } from '@supabase-evals/core';
import { codexGpt6Luna, evalLocalStack } from '../presets.js';
import { skipUnlessCli } from './lib/skip.js';

export default defineExperiment({
  ...codexGpt6Luna,
  suite: ['cli'],
  localStack: evalLocalStack({ cliVersion: 'beta' }),
  skipEval: skipUnlessCli,
});
