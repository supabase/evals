import { defineExperiment } from '@supabase-evals/core';
import { claudeCodeSonnet5 } from '../presets.js';
import { skipUnlessCorpusEvals } from './lib/skip.js';

// Control: the preset unchanged (full docs via MCP, skills, and open web).
// Identical to `claude-code-sonnet-5`, but tagged `corpus` so the three
// corpus experiments run together with `--experiment-suite corpus`.
export default defineExperiment({
  ...claudeCodeSonnet5,
  suite: ['corpus'],
  skipEval: skipUnlessCorpusEvals,
});
