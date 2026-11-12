import { defineExperiment } from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';
import { claudeCodeOpus55 } from '../presets.js';
import { EVAL_ENV } from './lib/eval-env.js';
import { skipUnlessCli } from './lib/skip.js';

export default defineExperiment({
  ...claudeCodeOpus55,
  localStack: localStackRuntime({ cliVersion: 'stable', env: EVAL_ENV }),
  skipEval: skipUnlessCli,
});
