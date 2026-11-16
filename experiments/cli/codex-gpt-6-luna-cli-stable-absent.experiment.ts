import { defineExperiment } from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';
import { codexGpt6Luna } from '../presets.js';
import { EVAL_ENV } from './lib/eval-env.js';
import { skipUnlessDockerless } from './lib/skip.js';

export default defineExperiment({
  ...codexGpt6Luna,
  localStack: localStackRuntime({
    cliVersion: 'stable',
    docker: 'absent',
    env: EVAL_ENV,
    experimentalFallback: true,
  }),
  skipEval: skipUnlessDockerless,
});
