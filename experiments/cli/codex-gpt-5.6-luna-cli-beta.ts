import { defineExperiment } from '@supabase-evals/core';
import { baselineExperiment } from '../presets.js';
import {
  dockerAwareLocalStackRuntime,
  skipUnlessCli,
} from './_lib/docker-aware-local-stack.js';

export default defineExperiment({
  suite: ['cli'],
  ...baselineExperiment,
  localStack: dockerAwareLocalStackRuntime({ channel: 'beta' }),
  skipEval: skipUnlessCli,
});
