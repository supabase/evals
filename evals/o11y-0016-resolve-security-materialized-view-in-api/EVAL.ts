import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.order_totals is a materialized view — RLS cannot be applied to
// matviews. The fix drops the matview or revokes anon/authenticated SELECT.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkMatviewDroppedOrRevoked(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated materialized view fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function checkMatviewDroppedOrRevoked(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  // Check if matview still exists.
  const { rows: matviewRows } = await ctx.query(stripIndent`
    SELECT relname FROM pg_class
    WHERE relname = 'order_totals'
      AND relnamespace = 'public'::regnamespace
      AND relkind = 'm';
  `);

  if (matviewRows.length === 0) {
    return {
      name: 'order_totals materialized view dropped or grants revoked',
      passed: true,
      notes: 'matview dropped',
    };
  }

  // Still exists — check grants revoked.
  const { rows: grantRows } = await ctx.query(stripIndent`
    SELECT grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'order_totals'
      AND grantee IN ('anon', 'authenticated');
  `);

  return {
    name: 'order_totals materialized view dropped or grants revoked',
    passed: grantRows.length === 0,
    notes: `matview still exists; grants remaining: ${grantRows.map(r => `${r.grantee}:${r.privilege_type}`).join(', ') || 'none'}`,
  };
}
