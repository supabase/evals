import { defineExperiment } from '@supabase-evals/core';
import { codexGpt61Sol } from '../presets.js';
import { cliRuntime } from './lib/cli-runtime.js';
import { EVAL_ENV } from './lib/eval-env.js';
import { skipUnlessCli } from './lib/skip.js';

const runtime = {
  cliVersion: 'stable',
  env: EVAL_ENV,
} as const;

export default defineExperiment({
  ...codexGpt61Sol,
  localStack: cliRuntime(runtime),
  fallbackConfig: {
    localStack: cliRuntime({ ...runtime, experimental: true }),
  },
  skipEval: skipUnlessCli,
});
