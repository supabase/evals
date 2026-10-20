import { defineExperiment } from '@supabase-evals/core';
import { codexGpt6Luna, evalLocalStack } from '../presets.js';
import { skipUnlessDockerless } from './lib/skip.js';

export default defineExperiment({
  ...codexGpt6Luna,
  suite: ['cli'],
  // beta: the Docker-less path only exists in the managed stack, which ships in beta.
  localStack: evalLocalStack({ cliVersion: 'beta', docker: 'absent' }),
  skipEval: skipUnlessDockerless,
});
