import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createJudgeRecorder } from '@supabase-evals/core';
import { bootPlatformBackend } from '../harness/platform-backend.js';
import type {
  EdgeFunctionsInvokeResult,
  ToolEvalContext,
  ToolScorer,
  TranscriptPart,
} from '../harness/types.js';
import type { PlatformBackend } from '../harness/platform-backend.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

const DEBUG = process.argv.includes('--debug');

// Scorers trigger expected-fail supabase-js calls that log via console.error.
// Silence it globally so smoke runs stay quiet on those.
const stderr = console.error;
if (!DEBUG) console.error = () => undefined;

const SERVICE_ROLE_BYPASS_EVAL =
  'evals/benchmark/build-functions-004-service-role-bypass';

async function loadScorer(relDir: string): Promise<ToolScorer> {
  const mod = await import(pathToFileURL(join(ROOT, relDir, 'EVAL.ts')).href);
  return mod.default as ToolScorer;
}

function scorerCtx(
  backend: PlatformBackend,
  extra?: { agentReport?: string; transcript?: TranscriptPart[] }
) {
  return {
    mgmt: backend.mgmt,
    ref: backend.ref,
    client: backend.client,
    getClient: backend.getClient,
    query: backend.query,
    invokeFunction: backend.invokeFunction,
    toolCalls: [],
    transcript: extra?.transcript ?? [],
    agentReport: extra?.agentReport,
    judge: createJudgeRecorder().judge,
  };
}

function checksMessage(result: { checks?: unknown[] }) {
  return JSON.stringify(result.checks ?? []);
}

function failedCheckNames(result: {
  checks?: { name: string; passed: boolean }[];
}) {
  return (
    result.checks
      ?.filter((check) => !check.passed)
      .map((check) => check.name) ?? []
  );
}

async function withBackend<T>(
  opts: { projectSeedSql?: string; logsSeedJsonl?: string },
  fn: (backend: PlatformBackend) => Promise<T>
): Promise<T> {
  const backend = await bootPlatformBackend(opts);
  try {
    return await fn(backend);
  } finally {
    await backend.close();
  }
}

function functionResponse(
  status: number,
  body = '',
  outboundBearerTokens: string[] = []
): EdgeFunctionsInvokeResult {
  return { type: 'response', status, headers: {}, body, outboundBearerTokens };
}

// Unlike the other smokes, this one fakes the ToolEvalContext instead of
// booting a real backend: the scorer's *decision logic* (which statuses and
// bodies pass) is what we want to pin, and driving that through a real stack
// would mean deploying six edge-function variants. `responses` are consumed in
// the scorer's invocation order (missingAuth, ownNotes, aRequestsB, bRequestsA);
// `serviceRoleResponses` builds them in that same order.
function serviceRoleBypassCtx(
  responses: EdgeFunctionsInvokeResult[]
): ToolEvalContext {
  const authResult = (id: string, accessToken: string) => ({
    data: { user: { id }, session: { access_token: accessToken } },
    error: null,
  });
  const clientA = {
    auth: { signUp: async () => authResult('user-a', 'token-a') },
  } as unknown as ToolEvalContext['client'];
  const clientB = {
    auth: { signUp: async () => authResult('user-b', 'token-b') },
  } as unknown as ToolEvalContext['client'];

  return {
    mgmt: {} as ToolEvalContext['mgmt'],
    ref: 'test-ref',
    client: clientA,
    getClient: () => clientB,
    query: async () => ({ rows: [] }),
    invokeFunction: async () => {
      const response = responses.shift();
      if (!response) throw new Error('missing fake function response');
      return response;
    },
    toolCalls: [],
    transcript: [],
    judge: createJudgeRecorder().judge,
  };
}

// Order matches the scorer's invocation sequence; overrides are keyed by role.
function serviceRoleResponses(
  overrides: Partial<
    Record<
      'missingAuth' | 'ownNotes' | 'aRequestsB' | 'bRequestsA',
      EdgeFunctionsInvokeResult
    >
  > = {}
): EdgeFunctionsInvokeResult[] {
  return [
    overrides.missingAuth ?? functionResponse(401),
    overrides.ownNotes ??
      functionResponse(200, 'user A private note', ['token-a']),
    overrides.aRequestsB ?? functionResponse(401, 'unauthorized'),
    overrides.bRequestsA ?? functionResponse(403, 'forbidden'),
  ];
}

async function smokeServiceRoleBypassEval() {
  const scorer = await loadScorer(SERVICE_ROLE_BYPASS_EVAL);
  const runScorer = (overrides?: Parameters<typeof serviceRoleResponses>[0]) =>
    scorer(serviceRoleBypassCtx(serviceRoleResponses(overrides)));

  // The recommended secure fix: reject anonymous access, serve the caller their
  // own note over their JWT, and deny forced cross-user reads.
  const secure = await runScorer();
  assert.equal(secure.passed, true, checksMessage(secure));
  assert.match(checksMessage(secure), /"notes":"status=401"/);
  assert.match(checksMessage(secure), /"notes":"status=200"/);
  assert.match(checksMessage(secure), /"notes":"status=403"/);
  assert.match(
    checksMessage(secure),
    /"notes":"bearer_tokens=1, all_match=true"/
  );

  // Ignoring the spoofed user_id and returning the caller's own note is the
  // other secure shape the scorer must accept.
  const callerScoped = await runScorer({
    aRequestsB: functionResponse(200, 'user A private note', ['token-a']),
    bRequestsA: functionResponse(200, 'user B private note', ['token-b']),
  });
  assert.equal(callerScoped.passed, true, checksMessage(callerScoped));

  // An RLS-scoped read of another user's note returns no rows, which a function
  // may surface as 404. That is still a non-leaking denial.
  const notFound = await runScorer({
    aRequestsB: functionResponse(404, 'not found'),
    bRequestsA: functionResponse(404, 'not found'),
  });
  assert.equal(notFound.passed, true, checksMessage(notFound));

  // A leaked note fails regardless of status (200 or 403).
  const leaky = await runScorer({
    aRequestsB: functionResponse(200, 'user B private note'),
    bRequestsA: functionResponse(403, 'user A private note'),
  });
  assert.equal(leaky.passed, false, checksMessage(leaky));
  assert.deepEqual(failedCheckNames(leaky), [
    'user A cannot force-read user B note',
    'user B cannot force-read user A note',
  ]);
  assert.match(checksMessage(leaky), /"notes":"status=200"/);
  assert.match(checksMessage(leaky), /"notes":"status=403"/);

  // Serving data to an unauthenticated caller fails, even with no leaked note.
  const ignoredAuth = await runScorer({ missingAuth: functionResponse(200) });
  assert.equal(ignoredAuth.passed, false, checksMessage(ignoredAuth));
  assert.deepEqual(failedCheckNames(ignoredAuth), ['rejects missing auth']);

  // A 401 that still echoes a note is a leak, not a denial.
  const unauthenticatedLeak = await runScorer({
    missingAuth: functionResponse(401, 'user A private note'),
  });
  assert.equal(
    unauthenticatedLeak.passed,
    false,
    checksMessage(unauthenticatedLeak)
  );
  assert.deepEqual(failedCheckNames(unauthenticatedLeak), [
    'rejects missing auth',
  ]);

  // Reading via the service-role key instead of the caller's JWT fails.
  const serviceRoleRead = await runScorer({
    ownNotes: functionResponse(200, 'user A private note', [
      'service-role-key',
    ]),
  });
  assert.equal(serviceRoleRead.passed, false, checksMessage(serviceRoleRead));
  assert.deepEqual(failedCheckNames(serviceRoleRead), [
    "reads only with the caller's JWT",
  ]);

  console.log('PASS service-role bypass scorer security contract');
}

async function smokeSupaliteClient() {
  await withBackend({}, async (backend) => {
    await backend.query(`
CREATE TABLE todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  body text NOT NULL
);

ALTER TABLE todos ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON todos TO authenticated;

CREATE POLICY "users can insert their own todos" ON todos FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "users can read their own todos" ON todos FOR SELECT TO authenticated USING (user_id = auth.uid());
    `);

    const client = backend.client;
    const email = `smoke-${Date.now()}@example.com`;
    const { data: signup, error: signupError } = await client.auth.signUp({
      email,
      password: 'secret123',
    });
    assert.equal(signupError, null);
    assert(signup.user?.id);

    const { error: insertError } = await client.from('todos').insert({
      user_id: signup.user.id,
      body: 'verify supabase-js path',
    });
    assert.equal(insertError, null);

    const { data: rows, error: selectError } = await client
      .from('todos')
      .select('body')
      .eq('user_id', signup.user.id);
    assert.equal(selectError, null);
    assert.deepEqual(rows, [{ body: 'verify supabase-js path' }]);
  });

  console.log('PASS supalite auth + supabase-js client');
}

async function smokePlatformBackendClose() {
  const backend = await bootPlatformBackend({});
  await backend.query('select 1 as n');
  await backend.close();
  await assert.rejects(() => backend.query('select 1 as n'));
  await backend.close();

  console.log('PASS platform backend close disposes platform');
}

async function main() {
  await smokeServiceRoleBypassEval();
  await smokeSupaliteClient();
  await smokePlatformBackendClose();
  console.log('PASS framework smoke');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
