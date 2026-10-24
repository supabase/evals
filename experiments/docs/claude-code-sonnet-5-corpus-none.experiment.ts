import { defineExperiment } from '@supabase-evals/core';
import { corpusBase } from './lib/corpus.js';
import { skipUnlessCorpusEvals } from './lib/skip.js';

// No docs corpus: no docs MCP tool, no skills, WebFetch and WebSearch blocked.
// A CLI agent cannot take a system prompt addendum, so there is no "use only
// what you know" instruction; the blocked tools enforce it. Shell fetches
// (curl) are not blocked and are audited with `pnpm corpus:audit`.
export default defineExperiment({
  ...corpusBase,
  suite: ['corpus'],
  skills: [],
  skipEval: skipUnlessCorpusEvals,
});
