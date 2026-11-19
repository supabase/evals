import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.orders has a FOR ALL policy with USING (true), effectively
// granting unrestricted access. The fix drops or rewrites the policy.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkNoAlwaysTruePolicy(ctx),
      await checkRlsStillEnabled(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated always-true policy fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function checkNoAlwaysTruePolicy(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT policyname, cmd, qual
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'orders'
      AND cmd IN ('ALL', 'UPDATE', 'DELETE')
      AND qual = 'true';
  `);
  return {
    name: 'no ALL/UPDATE/DELETE policy with USING (true) remains',
    passed: rows.length === 0,
    notes: rows.length > 0
      ? `still present: ${rows.map(r => `${r.policyname}(${r.cmd})`).join(', ')}`
      : 'none found',
  };
}

async function checkRlsStillEnabled(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT relrowsecurity FROM pg_class
    WHERE oid = 'public.orders'::regclass;
  `);
  return {
    name: 'RLS still enabled on public.orders',
    passed: rows[0]?.relrowsecurity === true,
  };
}
