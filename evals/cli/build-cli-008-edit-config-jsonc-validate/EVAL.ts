import type { LocalStackScorer } from '@supabase-evals/core';
import { scoreConfigEdit } from '../lib/config-edit.js';

const scorer: LocalStackScorer = (ctx) =>
  scoreConfigEdit(ctx, {
    format: 'jsonc',
    validateConvention: true,
    localDir: new URL('./local/', import.meta.url),
  });

export default scorer;
