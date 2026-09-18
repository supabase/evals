import { defineExperiment } from '@supabase-evals/core';
import { baselineExperiment } from '../presets.js';
import {
  dockerAwareLocalStackRuntime,
  skipUnlessDockerless,
} from './_lib/docker-aware-local-stack.js';

export default defineExperiment({
  suite: ['cli'],
  ...baselineExperiment,
  // beta: the Docker-less path only exists in the managed stack, which ships in beta.
  localStack: dockerAwareLocalStackRuntime({
    channel: 'beta',
    docker: 'no-daemon',
  }),
  skipEval: skipUnlessDockerless,
});
