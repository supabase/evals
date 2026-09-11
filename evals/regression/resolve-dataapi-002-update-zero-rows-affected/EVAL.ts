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
const TASK_TITLE = 'write the quarterly report';

const scorer: ToolScorer = async (ctx) => {
  try {
    const setup = await setupTestUsers(ctx);
    if ('failure' in setup) {
      return { passed: false, checks: [setup.failure] };
    }
    const users = setup.users;
    const taskId = await seedTask(ctx, users);

    const checks: CheckResult[] = [
      await checkRlsStillEnabled(ctx),
      await checkUserACanCheckOffOwnTask(users, taskId),
      await checkUserBCannotUpdateUserATask(ctx, users, taskId),
      await checkFixedUpdatePolicy(ctx),
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
          name: 'scorer evaluated the zero-rows-updated fix',
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
    email: `zero-rows-a-${Date.now()}@example.com`,
    password: PASSWORD,
  });
  const { data: authB, error: authBError } = await clientB.auth.signUp({
    email: `zero-rows-b-${Date.now()}@example.com`,
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

async function seedTask(
  ctx: ToolEvalContext,
  users: TestUsers
): Promise<string> {
  const { rows } = await ctx.query(`
INSERT INTO tasks (user_id, title, is_done) VALUES ('${users.userAId}', '${TASK_TITLE}', false)
RETURNING id;
  `);
  return String(rows[0]?.id);
}

async function checkRlsStillEnabled(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(
    `SELECT relrowsecurity FROM pg_class WHERE relname = 'tasks';`
  );

  return {
    name: 'RLS still enabled on tasks',
    passed: rows[0]?.relrowsecurity === true,
  };
}

async function checkUserACanCheckOffOwnTask(
  users: TestUsers,
  taskId: string
): Promise<CheckResult> {
  const { data, error } = await users.clientA
    .from('tasks')
    .update({ is_done: true })
    .eq('id', taskId)
    .select('id,is_done');

  return {
    name: "user A's update actually checks off their own task",
    passed: !error && data?.length === 1 && data[0]?.is_done === true,
    notes: error?.message ?? `saw: ${JSON.stringify(data)}`,
  };
}

async function checkUserBCannotUpdateUserATask(
  ctx: ToolEvalContext,
  users: TestUsers,
  taskId: string
): Promise<CheckResult> {
  await users.clientB
    .from('tasks')
    .update({ title: 'hijacked by user B' })
    .eq('id', taskId)
    .select('id');
  const { rows } = await ctx.query(
    `SELECT title FROM tasks WHERE id = '${taskId}';`
  );

  return {
    name: "user B cannot update user A's task",
    passed: rows[0]?.title !== 'hijacked by user B',
  };
}

async function checkFixedUpdatePolicy(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, {
      includeToolCallInputs: true,
    }),
    rubric: stripIndent`
      Pass if the assistant diagnoses the silent zero-row UPDATE as a Row Level Security policy missing its USING clause and fixes it by adding one.

      A passing answer should:
      - Recognize that the existing UPDATE policy on tasks only has a WITH CHECK clause, so Postgres has no USING clause to find the row before it can update it, so the UPDATE matches and changes 0 rows without erroring.
      - Fix it by adding a USING clause to that UPDATE policy scoped to the row owner, e.g. USING (user_id = auth.uid()), keeping the existing WITH CHECK (user_id = auth.uid()) so a user still can't reassign a task to someone else.
      - Keep the policy scoped to the authenticated role and to the task's own user_id (not a blanket true), and keep RLS enabled on tasks.

      Fail if the assistant blames something other than the missing USING clause (e.g. client code, caching, a trigger), disables RLS, replaces the policy with USING (true) or drops the WITH CHECK clause, scopes the policy to anon/public, or never fixes the UPDATE policy.
    `,
  });

  return {
    name: 'diagnosed the missing USING clause and added it',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
