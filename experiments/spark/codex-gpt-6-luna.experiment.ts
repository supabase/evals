import { defineExperiment, sparkRestRuntime } from '@supabase-evals/core';
import { codexGpt6Luna } from '../presets.js';

export default defineExperiment({
  agent: codexGpt6Luna.agent,
  runtime: sparkRestRuntime(process.env.SPARK_API_URL ?? ''),
  skills: ['spark-api'],
});
