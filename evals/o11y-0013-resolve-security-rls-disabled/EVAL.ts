import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.profiles has RLS disabled and SELECT granted to anon.
// A correct fix enables RLS and adds an owner-scoped SELECT policy, without
// breaking normal writes to the table.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkRlsEnabled(ctx),
      await checkOwnerScopedPolicy(ctx),
      await checkInsertsStillWork(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: 'scorer evaluated RLS fix', passed: false, notes: msg }],
    };
  }
};

export default scorer;

/** RLS must be enabled on public.profiles. */
async function checkRlsEnabled(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT relrowsecurity
    FROM pg_class
    WHERE oid = 'public.profiles'::regclass;
  `);
  return {
    name: 'RLS enabled on public.profiles',
    passed: rows[0]?.relrowsecurity === true,
    notes: `relrowsecurity=${rows[0]?.relrowsecurity}`,
  };
}

/** At least one SELECT policy must exist that scopes rows to the current user. */
async function checkOwnerScopedPolicy(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT policyname, qual
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'profiles'
      AND (cmd = 'SELECT' OR cmd = 'ALL');
  `);
  const hasOwnerScope = rows.some((r) =>
    /auth\.uid\(\)/i.test(String(r.qual ?? ''))
  );
  return {
    name: 'owner-scoped SELECT policy references auth.uid()',
    passed: hasOwnerScope,
    notes: `found ${rows.length} select-capable policies`,
  };
}

/** The fix must not break normal writes to the table. */
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
