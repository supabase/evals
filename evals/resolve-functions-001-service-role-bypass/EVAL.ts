import type { CheckResult, ToolScorer } from "@supabase-evals/core";

const FUNCTION_NAME = "private-notes";
const PASSWORD = "secret123";
const NOTE_A = "user A private note";
const NOTE_B = "user B private note";

const scorer: ToolScorer = async (ctx) => {
  const clientA = ctx.client;
  const clientB = ctx.getClient();

  const { data: authA, error: authAError } = await clientA.auth.signUp({
    email: "private-notes-a@example.com",
    password: PASSWORD,
  });
  const { data: authB, error: authBError } = await clientB.auth.signUp({
    email: "private-notes-b@example.com",
    password: PASSWORD,
  });

  if (
    authAError ||
    authBError ||
    !authA.user?.id ||
    !authA.session?.access_token ||
    !authB.user?.id ||
    !authB.session?.access_token
  ) {
    throw new Error(
      `failed to create test users: ${
        [authAError?.message, authBError?.message].filter(Boolean).join("; ") ||
        "missing session"
      }`,
    );
  }

  const callerToken = authA.session.access_token;
  const authHeadersA = { authorization: `Bearer ${callerToken}` };
  const authHeadersB = {
    authorization: `Bearer ${authB.session.access_token}`,
  };

  await ctx.query(`
INSERT INTO private_notes (user_id, body) VALUES
  ('${authA.user.id}', '${NOTE_A}'),
  ('${authB.user.id}', '${NOTE_B}');
  `);

  const invoke = (input: { path?: string; headers?: Record<string, string> }) =>
    ctx.invokeFunction({ name: FUNCTION_NAME, method: "GET", ...input });

  const missingAuth = await invoke({});
  const ownNotes = await invoke({
    path: `?user_id=${authA.user.id}`,
    headers: authHeadersA,
  });
  const aRequestsB = await invoke({
    path: `?user_id=${authB.user.id}`,
    headers: authHeadersA,
  });
  const bRequestsA = await invoke({
    path: `?user_id=${authA.user.id}`,
    headers: authHeadersB,
  });

  const checks: CheckResult[] = [
    {
      name: "rejects missing auth",
      passed:
        missingAuth.type === "response" &&
        (missingAuth.status === 401 || missingAuth.status === 403),
      notes: missingAuth.type === "error" ? missingAuth.error : undefined,
    },
    {
      name: "user A reads own note",
      passed:
        ownNotes.type === "response" &&
        ownNotes.status === 200 &&
        ownNotes.body.includes(NOTE_A) &&
        !ownNotes.body.includes(NOTE_B),
      notes: ownNotes.type === "error" ? ownNotes.error : undefined,
    },
    {
      // Reads should run as the signed-in user, never the service-role key.
      name: "reads only with the caller's JWT",
      passed:
        ownNotes.type === "response" &&
        ownNotes.outboundBearerTokens.length > 0 &&
        ownNotes.outboundBearerTokens.every((token) => token === callerToken),
      notes: ownNotes.type === "error" ? ownNotes.error : undefined,
    },
    {
      name: "user A cannot force-read user B note",
      passed:
        aRequestsB.type === "response" &&
        aRequestsB.status === 200 &&
        !aRequestsB.body.includes(NOTE_B),
      notes: aRequestsB.type === "error" ? aRequestsB.error : undefined,
    },
    {
      name: "user B cannot force-read user A note",
      passed:
        bRequestsA.type === "response" &&
        bRequestsA.status === 200 &&
        !bRequestsA.body.includes(NOTE_A),
      notes: bRequestsA.type === "error" ? bRequestsA.error : undefined,
    },
  ];

  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
