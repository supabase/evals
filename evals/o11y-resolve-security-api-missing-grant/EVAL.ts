import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: SELECT has been revoked from anon on public.orders.
// The fix: GRANT SELECT ON public.orders TO anon;

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkAnonHasSelectGrant(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated missing grant fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function checkAnonHasSelectGrant(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT has_table_privilege('anon', 'public.orders', 'SELECT') AS can_select;
  `);
  return {
    name: 'anon has SELECT on public.orders',
    passed: rows[0]?.can_select === true,
    notes: `has_table_privilege(anon, orders, SELECT)=${rows[0]?.can_select}`,
  };
}
