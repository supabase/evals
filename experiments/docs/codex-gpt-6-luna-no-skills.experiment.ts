import { defineExperiment } from '@supabase-evals/core';
import { codexGpt6LunaNoSkills } from '../presets.js';
import { REPORT_EVAL_PREFIX } from '../../evals/docs/lib/report-scoring.js';

export default defineExperiment({
  ...codexGpt6LunaNoSkills,
  // the docs report evals need their own fake docs, so only their experiments run them
  skipEval: (ev) =>
    codexGpt6LunaNoSkills.skipEval(ev) || ev.id.startsWith(REPORT_EVAL_PREFIX),
});
