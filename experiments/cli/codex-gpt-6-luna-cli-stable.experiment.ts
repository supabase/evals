import { defineExperiment } from '@supabase-evals/core';
import { codexGpt6Luna, evalLocalStack } from '../presets.js';
import { skipUnlessCli } from './lib/skip.js';

export default defineExperiment({
  ...codexGpt6Luna,
  suite: ['cli'],
  // Currently equal to the pin (npm `latest` == SUPABASE_CLI_VERSION); kept
  // as drift insurance between pin bumps.
  localStack: evalLocalStack({ cliVersion: 'stable' }),
  skipEval: skipUnlessCli,
});
