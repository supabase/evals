import { defineExperiment } from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';
import { baselineExperiment } from '../presets.js';
import { skipUnlessDockerless } from './lib/skip.js';

export default defineExperiment({
  ...baselineExperiment,
  suite: ['cli'],
  // beta: the Docker-less path only exists in the managed stack, which ships in beta.
  localStack: localStackRuntime({ cliVersion: 'beta', docker: 'absent' }),
  skipEval: skipUnlessDockerless,
});
