import {
  judge,
  serializeTranscript,
  type CheckResult,
  type SupabaseClient,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const PASSWORD = 'secret123';

const scorer: ToolScorer = async (ctx) => {
  try {
    const setup = await setupTestUsers(ctx);
    if ('failure' in setup) {
      return { passed: false, checks: [setup.failure] };
    }
    const users = setup.users;
    await seedOwnedDocuments(ctx, users);

    const checks: CheckResult[] = [
      await checkRlsStillEnabled(ctx),
      await checkUserAReadsOnlyOwnDocuments(users),
      await checkUserBCannotReadUserADocuments(users),
      await checkSelectPolicyUsesInitplan(ctx),
      await checkPerformanceDiagnosis(ctx),
    ];

    return {
      passed: checks.every((check) => check.passed),
      checks,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated the RLS performance fix',
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};

export default scorer;

type TestUsers = {
  clientA: SupabaseClient;
  clientB: SupabaseClient;
  userAId: string;
  userBId: string;
};

async function setupTestUsers(
  ctx: ToolEvalContext
): Promise<{ users: TestUsers } | { failure: CheckResult }> {
  const clientA = ctx.client;
  const clientB = ctx.getClient();

  const { data: authA, error: authAError } = await clientA.auth.signUp({
    email: `rls-initplan-a-${Date.now()}@example.com`,
    password: PASSWORD,
  });
  const { data: authB, error: authBError } = await clientB.auth.signUp({
    email: `rls-initplan-b-${Date.now()}@example.com`,
    password: PASSWORD,
  });

  if (
    authAError ||
    authBError ||
    !authA.user?.id ||
    !authA.session ||
    !authB.user?.id ||
    !authB.session
  ) {
    return {
      failure: {
        name: 'created auth sessions',
        passed: false,
        notes: authAError?.message ?? authBError?.message ?? 'missing session',
      },
    };
  }

  return {
    users: { clientA, clientB, userAId: authA.user.id, userBId: authB.user.id },
  };
}

async function seedOwnedDocuments(
  ctx: ToolEvalContext,
  users: TestUsers
): Promise<void> {
  await ctx.query(stripIndent`
    INSERT INTO documents (user_id, title, body) VALUES
      ('${users.userAId}', 'A first', 'owned by A'),
      ('${users.userAId}', 'A second', 'owned by A'),
      ('${users.userBId}', 'B first', 'owned by B');
  `);
}

async function checkRlsStillEnabled(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(
    `SELECT relrowsecurity FROM pg_class WHERE relname = 'documents';`
  );

  return {
    name: 'RLS still enabled on documents',
    passed: rows[0]?.relrowsecurity === true,
    notes:
      rows[0]?.relrowsecurity === true
        ? undefined
        : 'RLS must stay enabled; disabling it is not an acceptable fix',
  };
}

async function checkUserAReadsOnlyOwnDocuments(
  users: TestUsers
): Promise<CheckResult> {
  const { data, error } = await users.clientA
    .from('documents')
    .select('title,user_id');

  const allOwned =
    !error &&
    Array.isArray(data) &&
    data.length === 2 &&
    data.every((row) => row.user_id === users.userAId);

  return {
    name: 'user A still reads exactly their own documents',
    passed: allOwned,
    notes: error?.message ?? `saw ${data?.length ?? 0} rows`,
  };
}

async function checkUserBCannotReadUserADocuments(
  users: TestUsers
): Promise<CheckResult> {
  const { data, error } = await users.clientB
    .from('documents')
    .select('title,user_id')
    .eq('user_id', users.userAId);

  return {
    name: "user B cannot read user A's documents",
    passed: !error && Array.isArray(data) && data.length === 0,
    notes: error?.message,
  };
}

/**
 * The performance fix: the ownership predicate must evaluate the auth call once
 * per query (an InitPlan) instead of once per row. In Postgres that means
 * wrapping it in a scalar subquery -- `(select auth.uid())` -- which renders in
 * pg_policies.qual with a nested SELECT. A bare `auth.uid()` predicate renders
 * without one.
 */
async function checkSelectPolicyUsesInitplan(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT qual
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'documents'
      AND cmd = 'SELECT';
  `);

  const quals = rows
    .map((row) => (typeof row.qual === 'string' ? row.qual : ''))
    .filter((qual) => qual.length > 0);

  const wrapsAuthInSubquery = quals.some(
    (qual) => /\bselect\b/i.test(qual) && /auth\.(uid|jwt)\b/i.test(qual)
  );

  return {
    name: 'SELECT policy evaluates auth.uid() as an InitPlan (wrapped in a subquery)',
    passed: wrapsAuthInSubquery,
    notes: quals.length
      ? quals.join(' | ')
      : 'no SELECT policy found on documents',
  };
}

async function checkPerformanceDiagnosis(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, {
      includeToolCallInputs: true,
    }),
    rubric: stripIndent`
      Pass if the assistant diagnoses the slow list query as the RLS policy calling auth.uid() once per row and fixes it by making the auth call evaluate a single time per query.

      A passing answer should:
      - Identify that the ownership predicate re-evaluates auth.uid() (or current_setting for the JWT) for every scanned row, so cost grows with table size.
      - Fix it by wrapping the auth call in a scalar subquery, e.g. USING ((select auth.uid()) = user_id), so Postgres caches it as an InitPlan and runs it once.
      - Keep the policy scoped to the row owner and keep RLS enabled.

      Fail if the assistant blames only a missing index and adds one without addressing the per-row auth.uid() call, disables RLS, replaces the predicate with a blanket USING (true) or otherwise widens who can read rows, scopes the policy to anon/public, or never touches the RLS policy.
    `,
  });

  return {
    name: 'diagnosed per-row auth.uid() re-evaluation and applied the InitPlan fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
