import type { EvalMetadata, EvalSuite } from '@supabase-evals/core';

/** The corpus experiments run only the 36 benchmark and regression evals. */
export function skipUnlessCorpusEvals(ev: {
  id: string;
  suite?: EvalSuite;
  metadata: EvalMetadata;
}): boolean {
  return ev.suite !== 'benchmark' && ev.suite !== 'regression';
}
