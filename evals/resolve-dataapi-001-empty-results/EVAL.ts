import {
  judge,
  serializeTranscript,
  type CheckResult,
  type SupabaseClient,
  type ToolEvalContext,
  type ToolScorer,
} from "@supabase-evals/core";
import { stripIndent } from "common-tags";

const PASSWORD = "secret123";
const BOOKMARK_A1 = "a bookmark alpha";
const BOOKMARK_A2 = "a bookmark beta";
const BOOKMARK_B = "b bookmark gamma";

const scorer: ToolScorer = async (ctx) => {
  try {
    const setup = await setupTestUsers(ctx);
    if ("failure" in setup) {
      return { passed: false, checks: [setup.failure] };
    }
    const users = setup.users;

    const checks: CheckResult[] = [
      await checkRlsStillEnabled(ctx),
      await checkUserAReadsOwnBookmarks(users),
      await checkUserBCannotReadUserABookmarks(users),
      await checkAnonReadsNoBookmarks(ctx),
      await checkUserACanSaveNewBookmark(users),
      await checkUserBCannotInsertAsUserA(ctx, users),
      await checkRlsDiagnosisAndOwnerPolicies(ctx),
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
          name: "scorer evaluated Data API fix",
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
  ctx: ToolEvalContext,
): Promise<{ users: TestUsers } | { failure: CheckResult }> {
  const clientA = ctx.client;
  const clientB = ctx.getClient();

  const { data: authA, error: authAError } = await clientA.auth.signUp({
    email: `empty-results-a-${Date.now()}@example.com`,
    password: PASSWORD,
  });
  const { data: authB, error: authBError } = await clientB.auth.signUp({
    email: `empty-results-b-${Date.now()}@example.com`,
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
        name: "created auth sessions",
        passed: false,
        notes: authAError?.message ?? authBError?.message ?? "missing session",
      },
    };
  }

  const userAId = authA.user.id;
  const userBId = authB.user.id;

  await ctx.query(`
INSERT INTO bookmarks (user_id, title, url) VALUES
  ('${userAId}', '${BOOKMARK_A1}', 'https://example.com/a1'),
  ('${userAId}', '${BOOKMARK_A2}', 'https://example.com/a2'),
  ('${userBId}', '${BOOKMARK_B}', 'https://example.com/b');
  `);

  return { users: { clientA, clientB, userAId, userBId } };
}

async function checkRlsStillEnabled(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(
    `SELECT relrowsecurity FROM pg_class WHERE relname = 'bookmarks';`,
  );

  return {
    name: "RLS still enabled on bookmarks",
    passed: rows[0]?.relrowsecurity === true,
  };
}

async function checkUserAReadsOwnBookmarks(users: TestUsers): Promise<CheckResult> {
  const { data, error } = await users.clientA
    .from("bookmarks")
    .select("title,user_id")
    .order("title");

  return {
    name: "user A reads own bookmarks",
    passed:
      !error &&
      data?.length === 2 &&
      data[0]?.title === BOOKMARK_A1 &&
      data[1]?.title === BOOKMARK_A2 &&
      data.every((row) => row.user_id === users.userAId),
    notes: error?.message,
  };
}

async function checkUserBCannotReadUserABookmarks(
  users: TestUsers,
): Promise<CheckResult> {
  const { data, error } = await users.clientB
    .from("bookmarks")
    .select("id")
    .eq("title", BOOKMARK_A1);

  return {
    name: "user B cannot read user A bookmarks",
    passed: !error && Array.isArray(data) && data.length === 0,
  };
}

async function checkAnonReadsNoBookmarks(ctx: ToolEvalContext): Promise<CheckResult> {
  const { data, error } = await ctx.getClient().from("bookmarks").select("id");

  return {
    name: "anon reads no bookmarks",
    passed: error !== null || data?.length === 0,
  };
}

async function checkUserACanSaveNewBookmark(users: TestUsers): Promise<CheckResult> {
  const { data, error } = await users.clientA
    .from("bookmarks")
    .insert({ title: "a bookmark delta", url: "https://example.com/a3" })
    .select("title,user_id");

  return {
    name: "user A can save a new bookmark",
    passed:
      !error &&
      data?.length === 1 &&
      data[0]?.title === "a bookmark delta" &&
      data[0]?.user_id === users.userAId,
    notes: error?.message,
  };
}

async function checkUserBCannotInsertAsUserA(
  ctx: ToolEvalContext,
  users: TestUsers,
): Promise<CheckResult> {
  await silenceExpectedError(() =>
    users.clientB
      .from("bookmarks")
      .insert({
        user_id: users.userAId,
        title: "planted by user B",
        url: "https://example.com/planted",
      })
      .select("id"),
  );
  const { rows } = await ctx.query(
    `SELECT count(*)::int AS count FROM bookmarks WHERE title = 'planted by user B';`,
  );

  return {
    name: "user B cannot insert a bookmark as user A",
    passed: rows[0]?.count === 0,
  };
}

async function checkRlsDiagnosisAndOwnerPolicies(
  ctx: ToolEvalContext,
): Promise<CheckResult> {
  // AI-822: empty Data API results must be handled as an RLS issue, not a
  // data/query problem, and fixed with owner-scoped policies.
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, {
      includeToolCallInputs: true,
    }),
    rubric: stripIndent`
      Pass if the assistant handles the empty Data API results as a Row Level Security issue and fixes it by creating RLS policies that let users read and insert only their own bookmarks.

      A passing answer should:
      - Diagnose that RLS is enabled on the bookmarks table with no policies, so the Data API returns zero rows to every user (deny-all by default).
      - Create a SELECT policy for the authenticated role using USING (user_id = auth.uid()).
      - Create an INSERT policy for the authenticated role that enforces user_id = auth.uid() via WITH CHECK.
      - Keep RLS enabled on the bookmarks table.

      Fail if the assistant disables RLS, creates permissive policies such as USING (true), scopes the policies to anon/public instead of authenticated, blames the empty results on data, query, or connection problems instead of RLS, or never creates the owner-scoped policies.
    `,
  });

  return {
    name: "diagnosed RLS and added owner-scoped policies",
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}

async function silenceExpectedError<T>(fn: () => PromiseLike<T>): Promise<T> {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}
