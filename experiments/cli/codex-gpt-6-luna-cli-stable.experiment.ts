import { defineExperiment } from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';
import { codexGpt6Luna } from '../presets.js';
import { skipUnlessCli } from './lib/skip.js';

export default defineExperiment({
  ...codexGpt6Luna,
  suite: ['cli'],
  // Currently equal to the pin (npm `latest` == SUPABASE_CLI_VERSION); kept
  // as drift insurance between pin bumps.
  localStack: localStackRuntime({ cliVersion: 'stable' }),
  skipEval: skipUnlessCli,
});
