import type {
  CheckResult,
  EdgeFunctionsInvokeResult,
  ToolScorer,
} from '@supabase-evals/core';

const FUNCTION_NAME = 'private-notes';
const PASSWORD = 'secret123';
const NOTE_A = 'user A private note';
const NOTE_B = 'user B private note';

function responseNote(res: EdgeFunctionsInvokeResult): string | undefined {
  return res.type === 'response' ? `status=${res.status}` : res.error;
}

// A cross-user or unauthenticated request is secure as long as it returns a
// graceful HTTP denial (or caller-scoped 200) and never echoes a forbidden
// note. The exact status is left to the implementation; the no-leak invariant
// is the real contract.
function secureResponse(
  name: string,
  res: EdgeFunctionsInvokeResult,
  acceptedStatuses: number[],
  forbiddenNotes: string[]
): CheckResult {
  return {
    name,
    passed:
      res.type === 'response' &&
      acceptedStatuses.includes(res.status) &&
      forbiddenNotes.every((note) => !res.body.includes(note)),
    notes: responseNote(res),
  };
}

const scorer: ToolScorer = async (ctx) => {
  const clientA = ctx.client;
  const clientB = ctx.getClient();

  const { data: authA, error: authAError } = await clientA.auth.signUp({
    email: 'private-notes-a@example.com',
    password: PASSWORD,
  });
  const { data: authB, error: authBError } = await clientB.auth.signUp({
    email: 'private-notes-b@example.com',
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
        [authAError?.message, authBError?.message].filter(Boolean).join('; ') ||
        'missing session'
      }`
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
    ctx.invokeFunction({ name: FUNCTION_NAME, method: 'GET', ...input });

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

  const ownNotesUsesCallerJwt =
    ownNotes.type === 'response' &&
    ownNotes.outboundBearerTokens.length > 0 &&
    ownNotes.outboundBearerTokens.every((token) => token === callerToken);

  const checks: CheckResult[] = [
    secureResponse(
      'rejects missing auth',
      missingAuth,
      [401, 403],
      [NOTE_A, NOTE_B]
    ),
    {
      name: 'user A reads own note',
      passed:
        ownNotes.type === 'response' &&
        ownNotes.status === 200 &&
        ownNotes.body.includes(NOTE_A) &&
        !ownNotes.body.includes(NOTE_B),
      notes: responseNote(ownNotes),
    },
    {
      // Reads should run as the signed-in user, never the service-role key.
      name: "reads only with the caller's JWT",
      passed: ownNotesUsesCallerJwt,
      notes:
        ownNotes.type === 'response'
          ? `bearer_tokens=${ownNotes.outboundBearerTokens.length}, all_match=${ownNotesUsesCallerJwt}`
          : ownNotes.error,
    },
    secureResponse(
      'user A cannot force-read user B note',
      aRequestsB,
      [200, 401, 403, 404],
      [NOTE_B]
    ),
    secureResponse(
      'user B cannot force-read user A note',
      bRequestsA,
      [200, 401, 403, 404],
      [NOTE_A]
    ),
  ];

  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
