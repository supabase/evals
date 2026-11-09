import { defineExperiment } from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';
import { codexGpt61Sol } from '../presets.js';
import { EVAL_ENV } from './lib/eval-env.js';
import { skipUnlessCli } from './lib/skip.js';

export default defineExperiment({
  ...codexGpt61Sol,
  localStack: localStackRuntime({ cliVersion: 'stable', env: EVAL_ENV }),
  skipEval: skipUnlessCli,
});
