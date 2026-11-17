import type { LocalStackScorer } from '@supabase-evals/core';
import { scoreConfigEdit } from '../lib/config-edit.js';

const scorer: LocalStackScorer = (ctx) =>
  scoreConfigEdit(ctx, {
    format: 'toml',
    validateConvention: false,
    localDir: new URL('./local/', import.meta.url),
  });

export default scorer;
