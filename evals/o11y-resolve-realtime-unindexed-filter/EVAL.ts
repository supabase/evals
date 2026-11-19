import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: orders.total_cents has no index; Realtime filter causes seq scan.
// The fix adds an index on total_cents.

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkIndexOnTotalCents(ctx),
    ];
    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: 'scorer evaluated unindexed filter fix', passed: false, notes: msg }],
    };
  }
};

export default scorer;

async function checkIndexOnTotalCents(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'orders'
      AND indexdef ~* '\(total_cents\)';
  `);
  return {
    name: 'index on orders(total_cents) exists',
    passed: rows.length >= 1,
    notes: rows.map(r => r.indexname).join(', ') || 'no index found',
  };
}
