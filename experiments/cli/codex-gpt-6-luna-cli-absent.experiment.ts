import { defineExperiment } from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';
import { codexGpt6Luna } from '../presets.js';
import { EVAL_ENV } from './lib/eval-env.js';
import { skipUnlessDockerless } from './lib/skip.js';

export default defineExperiment({
  ...codexGpt6Luna,
  // beta: the Docker-less path only exists in the managed stack, which ships in beta.
  localStack: localStackRuntime({
    cliVersion: 'beta',
    docker: 'absent',
    env: EVAL_ENV,
  }),
  skipEval: skipUnlessDockerless,
});
