import type { EvalMetadata } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { skipUnlessCorpusEvals } from './skip.js';

const metadata: EvalMetadata = {
  stage: 'build',
  product: ['database'],
  topic: ['sdk'],
  interface: 'cli',
};

describe('skipUnlessCorpusEvals', () => {
  it('runs benchmark and regression evals', () => {
    for (const suite of ['benchmark', 'regression'] as const) {
      expect(skipUnlessCorpusEvals({ id: 'e', suite, metadata })).toBe(false);
    }
  });

  it('skips every other suite', () => {
    for (const suite of ['docs', 'cli', 'other'] as const) {
      expect(skipUnlessCorpusEvals({ id: 'e', suite, metadata })).toBe(true);
    }
  });
});
