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

const scorer: ToolScorer = async (ctx) => {
  try {
    const setup = await setupTestUsers(ctx);
    if ("failure" in setup) {
      return { passed: false, checks: [setup.failure] };
    }
    const users = setup.users;

    const activeBefore = await checkVictimActiveBeforeDeletion(users);
    const flow = await runDeleteAccountFlow(ctx, users);

    const checks: CheckResult[] = [
      activeBefore,
      flow,
      await checkSessionsRevoked(ctx, users),
      await checkRefreshTokenRejected(ctx, users),
      await checkCannotSignBackIn(ctx, users),
      await checkBystanderUnaffected(users),
      await checkRevocationDiagnosis(ctx),
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
          name: "scorer evaluated deleted user access",
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};

export default scorer;

type TestUsers = {
  victim: SupabaseClient;
  bystander: SupabaseClient;
  victimId: string;
  victimEmail: string;
  victimRefreshToken: string;
  bystanderId: string;
};

async function setupTestUsers(
  ctx: ToolEvalContext,
): Promise<{ users: TestUsers } | { failure: CheckResult }> {
  const victim = ctx.client;
  const bystander = ctx.getClient();
  const victimEmail = `victim-${Date.now()}@example.com`;

  const { data: authV, error: authVError } = await victim.auth.signUp({
    email: victimEmail,
    password: PASSWORD,
  });
  const { data: authB, error: authBError } = await bystander.auth.signUp({
    email: `bystander-${Date.now()}@example.com`,
    password: PASSWORD,
  });

  if (
    authVError ||
    authBError ||
    !authV.user?.id ||
    !authV.session ||
    !authB.user?.id ||
    !authB.session
  ) {
    return {
      failure: {
        name: "created auth sessions",
        passed: false,
        notes: authVError?.message ?? authBError?.message ?? "missing session",
      },
    };
  }

  await ctx.query(`
INSERT INTO profiles (id, email, full_name) VALUES
  ('${authV.user.id}', '${victimEmail}', 'Victim User'),
  ('${authB.user.id}', 'bystander@example.com', 'Bystander User');
  `);

  return {
    users: {
      victim,
      bystander,
      victimId: authV.user.id,
      victimEmail,
      victimRefreshToken: authV.session.refresh_token,
      bystanderId: authB.user.id,
    },
  };
}

async function checkVictimActiveBeforeDeletion(users: TestUsers): Promise<CheckResult> {
  const { data, error } = await users.victim
    .from("notes")
    .insert({ body: "note before deletion" })
    .select("user_id");

  return {
    name: "victim session active before delete-account",
    passed: !error && data?.length === 1 && data[0]?.user_id === users.victimId,
    notes: error?.message,
  };
}

async function runDeleteAccountFlow(
  ctx: ToolEvalContext,
  users: TestUsers,
): Promise<CheckResult> {
  // supabase-js rpc() 404s against @supabase/lite 0.4.0, so the scorer runs
  // the function the way PostgREST executes an RPC: in a transaction under
  // the caller's role and JWT claims.
  try {
    await ctx.query(`
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '${users.victimId}';
SET LOCAL request.jwt.claim.role = 'authenticated';
SELECT public.delete_account();
COMMIT;
    `);
    return { name: "delete_account flow ran for the victim", passed: true };
  } catch (error) {
    try {
      await ctx.query("ROLLBACK;");
    } catch {
      // Clear aborted scorer transactions.
    }
    const msg = error instanceof Error ? error.message : String(error);
    return {
      name: "delete_account flow ran for the victim",
      passed: false,
      notes: msg,
    };
  }
}

async function checkSessionsRevoked(
  ctx: ToolEvalContext,
  users: TestUsers,
): Promise<CheckResult> {
  const { rows } = await ctx.query(
    `SELECT count(*)::int AS count FROM auth.sessions WHERE user_id = '${users.victimId}';`,
  );

  return {
    name: "delete-account revokes the user's sessions",
    passed: rows[0]?.count === 0,
    notes: `sessions left: ${rows[0]?.count}`,
  };
}

async function checkRefreshTokenRejected(
  ctx: ToolEvalContext,
  users: TestUsers,
): Promise<CheckResult> {
  const { data, error } = await ctx.getClient().auth.refreshSession({
    refresh_token: users.victimRefreshToken,
  });

  return {
    name: "deleted user's refresh token is rejected",
    passed: Boolean(error) || !data.session,
    notes: error ? undefined : "refresh token still produces a session",
  };
}

async function checkCannotSignBackIn(
  ctx: ToolEvalContext,
  users: TestUsers,
): Promise<CheckResult> {
  const { data, error } = await ctx.getClient().auth.signInWithPassword({
    email: users.victimEmail,
    password: PASSWORD,
  });

  return {
    name: "deleted user cannot sign back in",
    passed: Boolean(error) || !data.session,
    notes: error ? undefined : "deleted account can still sign in",
  };
}

async function checkBystanderUnaffected(users: TestUsers): Promise<CheckResult> {
  const { data, error } = await users.bystander
    .from("notes")
    .insert({ body: "bystander still works" })
    .select("user_id");

  return {
    name: "other users keep their sessions and access",
    passed: !error && data?.length === 1 && data[0]?.user_id === users.bystanderId,
    notes: error?.message,
  };
}

async function checkRevocationDiagnosis(ctx: ToolEvalContext): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, {
      includeToolCallInputs: true,
    }),
    rubric: stripIndent`
      Pass if the assistant diagnoses why the deleted account still works, fixes the delete-account flow with real revocation, explains the remaining access-token window, and correctly clarifies publishable vs secret API keys.

      A passing answer should:
      - Identify that delete_account only soft-deletes the profile row and never removes the auth user or revokes their sessions, so the account keeps signing in.
      - Fix the flow so the auth user is deleted (or equivalently their identity and sessions are removed), revoking their sessions and refresh tokens.
      - Explain that access tokens are stateless JWTs that stay valid until they expire even after revocation, so there can be a short window of access, and that server-side checks need auth.getUser() (or short JWT expiry) rather than only local JWT validation such as getClaims().
      - Explain that the publishable key belongs in frontend code where requests run under the signed-in user's JWT and RLS applies, while the secret key is server-only, bypasses RLS, and must never ship to the client.

      Fail if the assistant leaves the flow as a soft delete without revoking auth access, claims existing access tokens are instantly invalidated everywhere the moment the user is deleted, recommends putting the secret key or legacy service_role key in frontend code, says RLS applies to the secret key, or blames the symptom on caching or client bugs instead of the flow.
    `,
  });

  return {
    name: "diagnosed and explained session revocation",
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
