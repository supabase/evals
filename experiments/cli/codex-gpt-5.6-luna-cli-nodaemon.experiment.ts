import { defineExperiment } from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';
import { codexGpt56Luna } from '../presets.js';
import { skipUnlessDockerless } from './lib/skip.js';

export default defineExperiment({
  ...codexGpt56Luna,
  suite: ['cli'],
  // beta: the Docker-less path only exists in the managed stack, which ships in beta.
  localStack: localStackRuntime({ cliVersion: 'beta', docker: 'no-daemon' }),
  skipEval: skipUnlessDockerless,
});
