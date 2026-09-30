import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: orders is in supabase_realtime publication with RLS enabled but no
// SELECT policy. The fix adds a SELECT policy.

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkSelectPolicyExists(ctx),
      await checkRlsEnabled(ctx),
    ];
    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: 'scorer evaluated broadcast no-policy fix', passed: false, notes: msg }],
    };
  }
};

export default scorer;

async function checkSelectPolicyExists(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT policyname, cmd FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'orders'
      AND (cmd = 'SELECT' OR cmd = 'ALL');
  `);
  return {
    name: 'SELECT policy added to public.orders',
    passed: rows.length >= 1,
    notes: `policies: ${rows.map(r => `${r.policyname}(${r.cmd})`).join(', ') || 'none'}`,
  };
}

async function checkRlsEnabled(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(
    `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.orders'::regclass;`
  );
  return {
    name: 'RLS still enabled on orders',
    passed: rows[0]?.relrowsecurity === true,
  };
}
