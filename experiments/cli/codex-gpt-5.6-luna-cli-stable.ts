import { defineExperiment } from '@supabase-evals/core';
import { baselineExperiment } from '../presets.js';
import {
  dockerAwareLocalStackRuntime,
  skipUnlessCli,
} from './_lib/docker-aware-local-stack.js';

export default defineExperiment({
  suite: ['cli'],
  ...baselineExperiment,
  // Currently equal to the pin (npm `latest` == SUPABASE_CLI_VERSION); kept
  // as drift insurance between pin bumps.
  localStack: dockerAwareLocalStackRuntime({ channel: 'stable' }),
  skipEval: skipUnlessCli,
});
