import {
  judge,
  serializeTranscript,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
  type SupabaseClient,
} from "@supabase-evals/core";
import { stripIndent } from "common-tags";

const PASSWORD = "secret123";
const BOOKMARK_A1 = "a bookmark alpha";
const BOOKMARK_A2 = "a bookmark beta";
const BOOKMARK_B = "b bookmark gamma";

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const setup = await setupTestUsers(ctx);
    if ("failure" in setup) {
      return { passed: false, checks: [setup.failure] };
    }
    const users = setup.users;

    const checks: CheckResult[] = [
      await checkAutoExposeNotEnabled(ctx),
      await checkAuthenticatedGrants(ctx),
      await checkAnonNotGranted(ctx),
      await checkRlsStillEnabled(ctx),
      await checkUserAReadsOwnBookmarks(users),
      await checkUserBCannotReadUserABookmarks(users),
      await checkAnonReadsNoBookmarks(ctx),
      await checkUserACanSaveNewBookmark(users),
      await checkUserBCannotInsertAsUserA(ctx, users),
      await checkSecureDefaultDiagnosisAndFix(ctx),
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
  ctx: LocalStackEvalContext,
): Promise<{ users: TestUsers } | { failure: CheckResult }> {
  const clientA = await ctx.getClient();
  const clientB = await ctx.getClient();

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

  await execSql(
    ctx,
    stripIndent`
      INSERT INTO bookmarks (user_id, title, url) VALUES
        ('${userAId}', '${BOOKMARK_A1}', 'https://example.com/a1'),
        ('${userAId}', '${BOOKMARK_A2}', 'https://example.com/a2'),
        ('${userBId}', '${BOOKMARK_B}', 'https://example.com/b');
    `,
  );

  return { users: { clientA, clientB, userAId, userBId } };
}

/** Checks that the fix did not roll back secure-by-default table exposure. */
async function checkAutoExposeNotEnabled(
  ctx: LocalStackEvalContext,
): Promise<CheckResult> {
  const config = await ctx.readFile("supabase/config.toml");
  const explicitlyEnabled = /^\s*auto_expose_new_tables\s*=\s*true\s*$/m.test(
    config,
  );

  return {
    name: "auto_expose_new_tables is not enabled",
    passed: !explicitlyEnabled,
    notes: !explicitlyEnabled
      ? undefined
      : "supabase/config.toml sets auto_expose_new_tables = true",
  };
}

// TODO: Replace this with a shared local-stack executeSql helper once the
// scorer DB API is refactored away from SELECT-only ctx.query.
/** Runs non-SELECT SQL against the local stack database. */
async function execSql(ctx: LocalStackEvalContext, sql: string): Promise<void> {
  const encoded = Buffer.from(sql, "utf8").toString("base64");
  const result = await ctx.exec(
    stripIndent`
      DB_URL=$(supabase status -o json | node -e 'let input = ""; process.stdin.on("data", data => input += data); process.stdin.on("end", () => console.log(JSON.parse(input).DB_URL));')
      echo ${encoded} | base64 -d | psql "$DB_URL" -v ON_ERROR_STOP=1
    `,
  );

  if (!result.ok) {
    throw new Error(`SQL execution failed: ${result.stderr || result.stdout}`);
  }
}

/** Checks that authenticated clients can reach bookmarks through PostgREST. */
async function checkAuthenticatedGrants(
  ctx: LocalStackEvalContext,
): Promise<CheckResult> {
  const { rows } = await ctx.query(
    stripIndent`
      SELECT
        has_table_privilege('authenticated', 'public.bookmarks', 'SELECT') AS can_select,
        has_table_privilege('authenticated', 'public.bookmarks', 'INSERT') AS can_insert;
    `,
  );

  return {
    name: "authenticated has explicit bookmarks SELECT and INSERT grants",
    passed: rows[0]?.can_select === true && rows[0]?.can_insert === true,
    notes: `can_select=${String(rows[0]?.can_select)}, can_insert=${String(rows[0]?.can_insert)}`,
  };
}

/** Checks that signed-out clients were not granted bookmark access. */
async function checkAnonNotGranted(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(
    stripIndent`
      SELECT
        has_table_privilege('anon', 'public.bookmarks', 'SELECT') AS can_select,
        has_table_privilege('anon', 'public.bookmarks', 'INSERT') AS can_insert;
    `,
  );

  return {
    name: "anon does not have bookmarks SELECT or INSERT grants",
    passed: rows[0]?.can_select === false && rows[0]?.can_insert === false,
    notes: `can_select=${String(rows[0]?.can_select)}, can_insert=${String(rows[0]?.can_insert)}`,
  };
}

/** Checks that RLS remains enabled after exposing the table to authenticated users. */
async function checkRlsStillEnabled(ctx: LocalStackEvalContext): Promise<CheckResult> {
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

async function checkAnonReadsNoBookmarks(
  ctx: LocalStackEvalContext,
): Promise<CheckResult> {
  const anonClient = await ctx.getClient();
  const { data, error } = await anonClient.from("bookmarks").select("id");

  return {
    name: "anon reads no bookmarks",
    passed: error?.code === "42501" || data?.length === 0,
    notes: error ? `error ${error.code}: ${error.message}` : `${data?.length ?? 0} rows`,
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
  ctx: LocalStackEvalContext,
  users: TestUsers,
): Promise<CheckResult> {
  await users.clientB
    .from("bookmarks")
    .insert({
      user_id: users.userAId,
      title: "planted by user B",
      url: "https://example.com/planted",
    })
    .select("id");
  const { rows } = await ctx.query(
    `SELECT count(*)::int AS count FROM bookmarks WHERE title = 'planted by user B';`,
  );

  return {
    name: "user B cannot insert a bookmark as user A",
    passed: rows[0]?.count === 0,
  };
}

async function checkSecureDefaultDiagnosisAndFix(
  ctx: LocalStackEvalContext,
): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, {
      includeToolCallInputs: true,
    }),
    rubric: stripIndent`
      Pass if the assistant handles the empty Data API results as a secure-by-default Data API exposure issue and fixes the missing explicit grants for authenticated clients without weakening the existing owner-scoped RLS policies.

      A passing answer should:
      - Diagnose that the project has api.auto_expose_new_tables disabled or equivalent secure-by-default behavior, so SQL-created tables need explicit grants before authenticated clients can use them through the Data API.
      - Distinguish Data API table privileges from RLS. Grants make the table reachable; RLS policies decide which rows signed-in users can see or insert.
      - Notice that the bookmarks table already has owner-scoped SELECT and INSERT RLS policies, or at least avoid blaming the whole issue on missing RLS policies.
      - Grant SELECT and INSERT on public.bookmarks to authenticated, not anon or public.
      - Keep RLS enabled on the bookmarks table.

      Fail if the assistant only adds or edits RLS policies without addressing missing grants, disables RLS, grants access to anon/public, creates permissive policies such as USING (true), claims the core problem is missing RLS policies, blames the empty results only on data/query/connection problems, or never recognizes the secure-by-default Data API exposure behavior.
    `,
  });

  return {
    name: "diagnosed secure default grants without weakening RLS",
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
