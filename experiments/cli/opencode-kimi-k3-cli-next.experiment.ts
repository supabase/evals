import { defineExperiment } from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';
import { opencodeKimiK3 } from '../presets.js';
import { EVAL_ENV } from './lib/eval-env.js';
import { skipUnlessCli } from './lib/skip.js';

export default defineExperiment({
  ...opencodeKimiK3,
  localStack: localStackRuntime({ cliVersion: 'next', env: EVAL_ENV }),
  skipEval: skipUnlessCli,
});
