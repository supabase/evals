import { defineExperiment, sparkRuntime } from '@supabase-evals/core';
import { codexGpt6Luna } from '../presets.js';

export default defineExperiment({
  agent: codexGpt6Luna.agent,
  runtime: sparkRuntime(process.env.SPARK_API_URL ?? ''),
  skills: [...codexGpt6Luna.skills, 'spark'],
});
