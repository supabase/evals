import {
  judge,
  serializeTranscript,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
  type SupabaseClient,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const PASSWORD = 'secret123';
const ENTRY_A1 = 'morning reflection';
const ENTRY_A2 = 'weekend plans';
const ENTRY_B = 'project notes';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const setup = await setupTestUsers(ctx);
    if ('failure' in setup) {
      return { passed: false, checks: [setup.failure] };
    }
    const users = setup.users;

    const checks: CheckResult[] = [
      await checkAutoExposeNotEnabled(ctx),
      await checkAuthenticatedGrants(ctx),
      await checkAnonNotGranted(ctx),
      await checkRlsStillEnabled(ctx),
      await checkUserAReadsOwnEntries(users),
      await checkUserBCannotReadUserAEntries(users),
      await checkAnonReadsNoEntries(ctx),
      await checkUserACanSaveNewEntry(users),
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
          name: 'scorer evaluated Data API fix',
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

/** Creates two signed-in clients and seeds journal entries for ownership checks. */
async function setupTestUsers(
  ctx: LocalStackEvalContext
): Promise<{ users: TestUsers } | { failure: CheckResult }> {
  const clientA = await ctx.getClient();
  const clientB = await ctx.getClient();

  const { data: authA, error: authAError } = await clientA.auth.signUp({
    email: `secure-default-grants-a-${Date.now()}@example.com`,
    password: PASSWORD,
  });
  const { data: authB, error: authBError } = await clientB.auth.signUp({
    email: `secure-default-grants-b-${Date.now()}@example.com`,
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

  const userAId = authA.user.id;
  const userBId = authB.user.id;

  await execSql(
    ctx,
    stripIndent`
      INSERT INTO journal_entries (user_id, title, body) VALUES
        ('${userAId}', '${ENTRY_A1}', 'A quiet start to the day.'),
        ('${userAId}', '${ENTRY_A2}', 'Ideas for Saturday and Sunday.'),
        ('${userBId}', '${ENTRY_B}', 'Notes from the latest project review.');
    `
  );

  return { users: { clientA, clientB, userAId, userBId } };
}

/** Checks that the fix did not roll back secure-by-default table exposure. */
async function checkAutoExposeNotEnabled(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const config = await ctx.readFile('supabase/config.toml');
  const explicitlyEnabled = /^\s*auto_expose_new_tables\s*=\s*true\s*$/m.test(
    config
  );

  return {
    name: 'auto_expose_new_tables is not enabled',
    passed: !explicitlyEnabled,
    notes: !explicitlyEnabled
      ? undefined
      : 'supabase/config.toml sets auto_expose_new_tables = true',
  };
}

// TODO: Replace this with a shared local-stack executeSql helper once the
// scorer DB API is refactored away from SELECT-only ctx.query.
/** Runs non-SELECT SQL against the local stack database. */
async function execSql(ctx: LocalStackEvalContext, sql: string): Promise<void> {
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  const result = await ctx.exec(
    stripIndent`
      DB_URL=$(supabase status -o json | node -e 'let input = ""; process.stdin.on("data", data => input += data); process.stdin.on("end", () => console.log(JSON.parse(input).DB_URL));')
      echo ${encoded} | base64 -d | psql "$DB_URL" -v ON_ERROR_STOP=1
    `
  );

  if (!result.ok) {
    throw new Error(`SQL execution failed: ${result.stderr || result.stdout}`);
  }
}

/** Checks that authenticated clients can reach journal entries through PostgREST. */
async function checkAuthenticatedGrants(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(
    stripIndent`
      SELECT
        has_table_privilege('authenticated', 'public.journal_entries', 'SELECT') AS can_select,
        has_table_privilege('authenticated', 'public.journal_entries', 'INSERT') AS can_insert;
    `
  );

  return {
    name: 'authenticated has explicit journal_entries SELECT and INSERT grants',
    passed: rows[0]?.can_select === true && rows[0]?.can_insert === true,
    notes: `can_select=${String(rows[0]?.can_select)}, can_insert=${String(rows[0]?.can_insert)}`,
  };
}

/** Checks that signed-out clients were not granted journal entry access. */
async function checkAnonNotGranted(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(
    stripIndent`
      SELECT
        has_table_privilege('anon', 'public.journal_entries', 'SELECT') AS can_select,
        has_table_privilege('anon', 'public.journal_entries', 'INSERT') AS can_insert;
    `
  );

  return {
    name: 'anon does not have journal_entries SELECT or INSERT grants',
    passed: rows[0]?.can_select === false && rows[0]?.can_insert === false,
    notes: `can_select=${String(rows[0]?.can_select)}, can_insert=${String(rows[0]?.can_insert)}`,
  };
}

/** Checks that RLS remains enabled after exposing the table to authenticated users. */
async function checkRlsStillEnabled(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(
    `SELECT relrowsecurity FROM pg_class WHERE relname = 'journal_entries';`
  );

  return {
    name: 'RLS still enabled on journal_entries',
    passed: rows[0]?.relrowsecurity === true,
  };
}

/** Checks that a signed-in user can read only their own journal entries. */
async function checkUserAReadsOwnEntries(
  users: TestUsers
): Promise<CheckResult> {
  const { data, error } = await users.clientA
    .from('journal_entries')
    .select('title,user_id')
    .order('title');

  return {
    name: 'user A reads own journal entries',
    passed:
      !error &&
      data?.length === 2 &&
      data[0]?.title === ENTRY_A1 &&
      data[1]?.title === ENTRY_A2 &&
      data.every((row) => row.user_id === users.userAId),
    notes: error?.message,
  };
}

/** Checks that one signed-in user cannot read another user's journal entries. */
async function checkUserBCannotReadUserAEntries(
  users: TestUsers
): Promise<CheckResult> {
  const { data, error } = await users.clientB
    .from('journal_entries')
    .select('id')
    .eq('title', ENTRY_A1);

  return {
    name: 'user B cannot read user A journal entries',
    passed: !error && Array.isArray(data) && data.length === 0,
  };
}

/** Checks that signed-out clients cannot read journal entries. */
async function checkAnonReadsNoEntries(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const anonClient = await ctx.getClient();
  const { data, error } = await anonClient.from('journal_entries').select('id');

  return {
    name: 'anon reads no journal entries',
    passed: error?.code === '42501' || data?.length === 0,
    notes: error
      ? `error ${error.code}: ${error.message}`
      : `${data?.length ?? 0} rows`,
  };
}

/** Checks that a signed-in user can create an owned journal entry. */
async function checkUserACanSaveNewEntry(
  users: TestUsers
): Promise<CheckResult> {
  const { data, error } = await users.clientA
    .from('journal_entries')
    .insert({ title: 'travel ideas', body: 'Places to visit next spring.' })
    .select('title,user_id');

  return {
    name: 'user A can save a new journal entry',
    passed:
      !error &&
      data?.length === 1 &&
      data[0]?.title === 'travel ideas' &&
      data[0]?.user_id === users.userAId,
    notes: error?.message,
  };
}

/** Checks that one signed-in user cannot create a journal entry for another user. */
async function checkUserBCannotInsertAsUserA(
  ctx: LocalStackEvalContext,
  users: TestUsers
): Promise<CheckResult> {
  await users.clientB
    .from('journal_entries')
    .insert({
      user_id: users.userAId,
      title: 'planted by user B',
      body: 'This should not be allowed.',
    })
    .select('id');
  const { rows } = await ctx.query(
    `SELECT count(*)::int AS count FROM journal_entries WHERE title = 'planted by user B';`
  );

  return {
    name: 'user B cannot insert a journal entry as user A',
    passed: rows[0]?.count === 0,
  };
}

/** Checks that the transcript identifies and safely fixes missing table grants. */
async function checkSecureDefaultDiagnosisAndFix(
  ctx: LocalStackEvalContext
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
      - Notice that the journal_entries table already has owner-scoped SELECT and INSERT RLS policies, or at least avoid blaming the whole issue on missing RLS policies.
      - Grant SELECT and INSERT on public.journal_entries to authenticated, not anon or public.
      - Keep RLS enabled on the journal_entries table.

      Fail if the assistant only adds or edits RLS policies without addressing missing grants, disables RLS, grants access to anon/public, creates permissive policies such as USING (true), claims the core problem is missing RLS policies, blames the empty results only on data/query/connection problems, or never recognizes the secure-by-default Data API exposure behavior.
    `,
  });

  return {
    name: 'diagnosed secure default grants without weakening RLS',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
