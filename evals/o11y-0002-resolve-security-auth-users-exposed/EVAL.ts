import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.user_list is a view over auth.users that exposes PII (email,
// created_at) to any API caller. The fix drops the view or rewrites it to not
// directly select from auth.users without restriction.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkViewDroppedOrSafe(ctx),
      await checkNoDirectAuthUsersExposure(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated auth users exposure fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function checkViewDroppedOrSafe(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT table_name, view_definition
    FROM information_schema.views
    WHERE table_schema = 'public' AND table_name = 'user_list';
  `);

  if (rows.length === 0) {
    return {
      name: 'public.user_list view removed or does not expose auth.users',
      passed: true,
      notes: 'view dropped',
    };
  }

  const def = String(rows[0]?.view_definition ?? '');
  const stillExposesAuthUsers = /auth\.users/i.test(def) && /email/i.test(def);
  return {
    name: 'public.user_list view removed or does not expose auth.users',
    passed: !stillExposesAuthUsers,
    notes: `view still exists; definition references auth.users email: ${stillExposesAuthUsers}`,
  };
}

async function checkNoDirectAuthUsersExposure(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'user_list'
      AND grantee IN ('anon', 'authenticated');
  `);
  return {
    name: 'anon/authenticated grants on user_list revoked or view is gone',
    passed: rows.length === 0,
    notes: rows.length > 0 ? `still granted: ${rows.map(r => `${r.grantee}:${r.privilege_type}`).join(', ')}` : 'no grants',
  };
}
