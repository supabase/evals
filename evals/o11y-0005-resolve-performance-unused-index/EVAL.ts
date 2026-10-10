import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: idx_unused_total indexes orders(total_cents) but no query ever filters
// on total_cents. The fix drops the index. Since "unused" is definitional
// (pg_stat_user_indexes shows 0 scans) we use a judge + structural check.

const scorer: ToolScorer = async (ctx) => {
  try {
    const unusedIndexDropped = await checkUnusedIndexDropped(ctx);
    const checks: CheckResult[] = [unusedIndexDropped];

    const verdict = await judge({
      input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
      rubric: stripIndent`
        Pass if the agent identified an unused index on the orders table
        (idx_unused_total or similar, covering total_cents) and dropped it.
        The agent should have explained that the index adds write overhead without
        benefiting any read query.

        Fail if the agent dropped the wrong index, kept the unused index, or
        gave only a recommendation without acting on it.
      `,
    });
    checks.push({
      name: 'correctly identified and dropped unused index',
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    });

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: 'scorer evaluated unused index fix', passed: false, notes: msg }],
    };
  }
};

export default scorer;

async function checkUnusedIndexDropped(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'orders'
      AND indexname = 'idx_unused_total';
  `);
  return {
    name: 'idx_unused_total index dropped',
    passed: rows.length === 0,
    notes: rows.length > 0 ? 'index still exists' : 'index dropped',
  };
}
