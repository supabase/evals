import { defineExperiment } from '@supabase-evals/core';
import { corpusBase } from './lib/corpus.js';
import { skipUnlessCorpusEvals } from './lib/skip.js';

// As corpus-none, plus the gap-docs local skill (corpora/gap-docs-2026-10-02).
// The skill's SKILL.md carries the "docs are local, do not access the web"
// instruction, since a CLI agent cannot take a system prompt addendum.
export default defineExperiment({
  ...corpusBase,
  suite: ['corpus'],
  skills: ['gap-docs-2026-10-02'],
  skipEval: skipUnlessCorpusEvals,
});
