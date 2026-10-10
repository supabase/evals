import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: profiles RLS policy calls auth.uid() via a VOLATILE wrapper function,
// forcing per-row re-evaluation. The fix rewrites the policy to call auth.uid()
// directly so Postgres uses the efficient initplan path.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkPolicyCallsAuthUidDirectly(ctx),
      await checkVolatileWrapperGone(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated RLS initplan fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function checkPolicyCallsAuthUidDirectly(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT policyname, qual
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'profiles'
      AND (cmd = 'SELECT' OR cmd = 'ALL');
  `);

  const hasDirectAuthUid = rows.some((r) => {
    const qual = String(r.qual ?? '');
    return /auth\.uid\(\)/i.test(qual) && !/current_user_id|get_user_id/i.test(qual);
  });

  return {
    name: 'SELECT policy calls auth.uid() directly (no volatile wrapper)',
    passed: hasDirectAuthUid,
    notes: rows.map(r => `${r.policyname}: ${r.qual}`).join('; '),
  };
}

async function checkVolatileWrapperGone(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT proname
    FROM pg_proc
    WHERE proname IN ('current_user_id', 'get_user_id')
      AND pronamespace = 'public'::regnamespace
      AND provolatile = 'v';
  `);
  return {
    name: 'VOLATILE wrapper function removed or no longer used in policy',
    passed: rows.length === 0,
    notes: rows.length > 0 ? `still exists: ${rows.map(r => r.proname).join(', ')}` : 'none found',
  };
}
