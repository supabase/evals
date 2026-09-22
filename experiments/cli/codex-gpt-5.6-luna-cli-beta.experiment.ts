import { defineExperiment } from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';
import { baselineExperiment } from '../presets.js';
import { skipUnlessCli } from './lib/skip.js';

export default defineExperiment({
  ...baselineExperiment,
  suite: ['cli'],
  localStack: localStackRuntime({ cliVersion: 'beta' }),
  skipEval: skipUnlessCli,
});
