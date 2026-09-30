import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: profiles has two PERMISSIVE SELECT policies for `authenticated`, which
// Postgres ORs together. The fix collapses SELECT access down to a single
// permissive policy (the owner-scoped one) so access is no longer widened.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkSinglePermissiveSelectPolicy(ctx),
      await checkRemainingPolicyIsOwnerScoped(ctx),
      await checkInsertsStillWork(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated policy fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function selectPolicies(ctx: ToolEvalContext) {
  const { rows } = await ctx.query(stripIndent`
    SELECT policyname, permissive, roles, qual
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'profiles'
      AND cmd = 'SELECT';
  `);
  return rows.filter((r) => {
    const roles = Array.isArray(r.roles)
      ? (r.roles as string[])
      : String(r.roles ?? '').replace(/[{}]/g, '').split(',');
    return (
      String(r.permissive).toUpperCase().startsWith('PERM') &&
      roles.includes('authenticated')
    );
  });
}

/** Exactly one permissive SELECT policy should remain for `authenticated`. */
async function checkSinglePermissiveSelectPolicy(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const policies = await selectPolicies(ctx);
  return {
    name: 'exactly one permissive SELECT policy for authenticated',
    passed: policies.length === 1,
    notes: `count=${policies.length}: ${policies
      .map((p) => p.policyname)
      .join(', ')}`,
  };
}

/** The surviving policy must still restrict to the row owner. */
async function checkRemainingPolicyIsOwnerScoped(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const policies = await selectPolicies(ctx);
  const ownerScoped = policies.some((p) =>
    /auth\.uid\(\)/i.test(String(p.qual ?? ''))
  );
  return {
    name: 'remaining SELECT policy is owner-scoped (auth.uid())',
    passed: policies.length >= 1 && ownerScoped,
  };
}

async function checkInsertsStillWork(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    INSERT INTO public.profiles (handle)
    VALUES ('regression_probe')
    RETURNING id;
  `);
  return {
    name: 'inserts still work after the fix',
    passed: rows.length === 1,
  };
}
