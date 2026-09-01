import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: storage.objects has no SELECT policy. The fix adds an owner-scoped
// SELECT policy for authenticated users.

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkSelectPolicyExists(ctx),
    ];
    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: 'scorer evaluated storage RLS fix', passed: false, notes: msg }],
    };
  }
};

export default scorer;

async function checkSelectPolicyExists(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT policyname, cmd, qual
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND cmd IN ('SELECT', 'ALL');
  `);
  return {
    name: 'SELECT policy exists on storage.objects',
    passed: rows.length >= 1,
    notes: `policies: ${rows.map(r => r.policyname).join(', ') || 'none'}`,
  };
}
