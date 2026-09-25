import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.orders has a SELECT policy defined but RLS is disabled, so the
// policy is never evaluated and all rows are visible. The fix enables RLS.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkRlsEnabled(ctx),
      await checkPolicyStillExists(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated RLS policy-exists-disabled fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function checkRlsEnabled(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT relrowsecurity FROM pg_class
    WHERE oid = 'public.orders'::regclass;
  `);
  return {
    name: 'RLS enabled on public.orders',
    passed: rows[0]?.relrowsecurity === true,
    notes: `relrowsecurity=${rows[0]?.relrowsecurity}`,
  };
}

async function checkPolicyStillExists(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'orders';
  `);
  return {
    name: 'RLS policy still exists on public.orders',
    passed: rows.length >= 1,
    notes: `policies: ${rows.map(r => r.policyname).join(', ') || 'none'}`,
  };
}
