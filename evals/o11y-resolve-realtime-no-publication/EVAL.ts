import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.realtime_events is not in supabase_realtime publication.
// The fix: ALTER PUBLICATION supabase_realtime ADD TABLE public.realtime_events;

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkTableInPublication(ctx),
    ];
    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: 'scorer evaluated realtime publication fix', passed: false, notes: msg }],
    };
  }
};

export default scorer;

async function checkTableInPublication(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT tablename FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'realtime_events';
  `);
  return {
    name: 'realtime_events is in supabase_realtime publication',
    passed: rows.length === 1,
    notes: rows.length === 0 ? 'table not in publication' : 'table in publication',
  };
}
