import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.api_keys has sensitive columns (password, secret) with RLS
// disabled. The fix enables RLS and adds an owner-scoped policy.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkRlsEnabled(ctx),
      await checkPolicyExists(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated sensitive columns fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function checkRlsEnabled(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT relrowsecurity FROM pg_class
    WHERE oid = 'public.api_keys'::regclass;
  `);
  return {
    name: 'RLS enabled on public.api_keys',
    passed: rows[0]?.relrowsecurity === true,
    notes: `relrowsecurity=${rows[0]?.relrowsecurity}`,
  };
}

async function checkPolicyExists(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'api_keys';
  `);
  return {
    name: 'at least one RLS policy exists on public.api_keys',
    passed: rows.length >= 1,
    notes: `policies: ${rows.map(r => r.policyname).join(', ') || 'none'}`,
  };
}
