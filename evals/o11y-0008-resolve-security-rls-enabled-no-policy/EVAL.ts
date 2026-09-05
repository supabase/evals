import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.documents has RLS enabled but no policies (Postgres default-deny
// returns zero rows for all non-superuser roles). The fix adds a policy.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkPolicyExists(ctx),
      await checkRlsStillEnabled(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated RLS no-policy fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function checkPolicyExists(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'documents';
  `);
  return {
    name: 'at least one RLS policy added to public.documents',
    passed: rows.length >= 1,
    notes: `policies: ${rows.map(r => r.policyname).join(', ') || 'none'}`,
  };
}

async function checkRlsStillEnabled(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT relrowsecurity FROM pg_class
    WHERE oid = 'public.documents'::regclass;
  `);
  return {
    name: 'RLS still enabled on public.documents',
    passed: rows[0]?.relrowsecurity === true,
  };
}
