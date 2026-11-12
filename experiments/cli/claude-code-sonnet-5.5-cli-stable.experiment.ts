import { defineExperiment } from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';
import { claudeCodeSonnet55 } from '../presets.js';
import { EVAL_ENV } from './lib/eval-env.js';
import { skipUnlessCli } from './lib/skip.js';

export default defineExperiment({
  ...claudeCodeSonnet55,
  localStack: localStackRuntime({ cliVersion: 'stable', env: EVAL_ENV }),
  skipEval: skipUnlessCli,
});
