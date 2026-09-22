import { defineExperiment } from '@supabase-evals/core';
import { localStackRuntime } from '@supabase-evals/sandbox';
import { codexGpt56Luna } from '../presets.js';
import { skipUnlessCli } from './lib/skip.js';

export default defineExperiment({
  ...codexGpt56Luna,
  suite: ['cli'],
  localStack: localStackRuntime({ cliVersion: 'beta' }),
  skipEval: skipUnlessCli,
});
