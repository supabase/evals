import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootPlatformBackend } from '../harness/platform-backend.js';
import { viteBuild, vitestRun } from '../harness/project-runner.js';
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

const CLIENT_RLS_EVAL = 'evals/build-rls-002-own-todos-client';
const FUNCTIONS_EVAL = 'evals/build-functions-001-order-total';
const EDGE_AUTH_DB_EVAL = 'evals/build-functions-002-edge-auth-db';
const SERVICE_ROLE_BYPASS_EVAL =
  'evals/build-functions-004-service-role-bypass';
const INVESTIGATE_LOGS_EVAL = 'evals/investigate-logs-001-top-error-function';
const INVESTIGATE_SECURITY_EVAL = 'evals/investigate-security-001-public-table';
const FRONTEND_EVAL = 'evals/build-frontend-001-todos-app';

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

function seedPath(relDir: string, file: string): string {
  return join(ROOT, relDir, 'remote', file);
}

async function smokeClientRlsEval() {
  const scorer = await loadScorer(CLIENT_RLS_EVAL);

  await withBackend(
    { projectSeedSql: seedPath(CLIENT_RLS_EVAL, 'project.sql') },
    async (backend) => {
      await backend.query(`
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users can read own todos" ON todos FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "users can insert own todos" ON todos FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "users can update own todos" ON todos FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "users can delete own todos" ON todos FOR DELETE TO authenticated USING (user_id = auth.uid());
      `);

      const result = await scorer(scorerCtx(backend));
      assert.equal(result.passed, true, checksMessage(result));
    }
  );

  console.log('PASS client-scored RLS scorer + supabase-js');
}

async function smokeFunctionsEval() {
  const scorer = await loadScorer(FUNCTIONS_EVAL);

  await withBackend({}, async (backend) => {
    const before = await scorer(scorerCtx(backend));
    assert.equal(before.passed, false);
    assert.match(checksMessage(before), /function not found/i);

    const deployUrl = `${backend.url}/v1/projects/${backend.ref}/functions/deploy?slug=order-total`;
    const form = new FormData();
    form.append(
      'metadata',
      JSON.stringify({
        name: 'order-total',
        verify_jwt: false,
        entrypoint_path: 'index.ts',
      })
    );
    form.append(
      'file',
      new File([ORDER_TOTAL_SOURCE], 'index.ts', {
        type: 'application/typescript',
      })
    );

    const deployRes = await fetch(deployUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${backend.accessToken}` },
      body: form,
    });
    assert.equal(
      deployRes.status,
      201,
      `deploy failed: ${await deployRes.text()}`
    );

    const after = await scorer(scorerCtx(backend));
    assert.equal(after.passed, true, checksMessage(after));
  });

  console.log('PASS functions scorer + edge-functions dispatcher');
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

async function smokeEdgeAuthDbEval() {
  const scorer = await loadScorer(EDGE_AUTH_DB_EVAL);

  await withBackend(
    { projectSeedSql: seedPath(EDGE_AUTH_DB_EVAL, 'project.sql') },
    async (backend) => {
      // Deploy the function via platform-lite's HTTP management API
      const deployUrl = `${backend.url}/v1/projects/${backend.ref}/functions/deploy?slug=todo-create`;
      const form = new FormData();
      form.append(
        'metadata',
        JSON.stringify({
          name: 'todo-create',
          verify_jwt: true,
          entrypoint_path: 'index.ts',
        })
      );
      form.append(
        'file',
        new File([TODO_CREATE_SOURCE], 'index.ts', {
          type: 'application/typescript',
        })
      );

      const deployRes = await fetch(deployUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${backend.accessToken}` },
        body: form,
      });
      assert.equal(
        deployRes.status,
        201,
        `deploy failed: ${await deployRes.text()}`
      );

      const result = await scorer(scorerCtx(backend));
      assert.equal(result.passed, true, checksMessage(result));
    }
  );

  console.log('PASS edge function auth + supabase-js DB scorer');
}

async function smokeLogsSeeding() {
  await withBackend(
    { logsSeedJsonl: seedPath(INVESTIGATE_LOGS_EVAL, 'logs.jsonl') },
    async ({ url, ref, accessToken }) => {
      const logsUrl = `${url}/v1/projects/${ref}/analytics/endpoints/logs.all?sql=${encodeURIComponent('SELECT count(*)::int AS n FROM edge_logs')}`;
      const res = await fetch(logsUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = (await res.json()) as { result: Array<{ n: number }> };
      assert(body.result[0] && body.result[0].n > 0, 'expected seeded logs');
    }
  );

  console.log('PASS logs seeding via platform-lite');
}

async function smokeInvestigateLogsEval() {
  const scorer = await loadScorer(INVESTIGATE_LOGS_EVAL);

  await withBackend(
    { logsSeedJsonl: seedPath(INVESTIGATE_LOGS_EVAL, 'logs.jsonl') },
    async (backend) => {
      const result = await scorer(
        scorerCtx(backend, {
          agentReport:
            'stripe-webhook had the most errors with 9 errors out of 50 events.',
        })
      );
      assert.equal(result.passed, true, checksMessage(result));
    }
  );

  console.log('PASS investigate logs scorer');
}

async function smokeInvestigateSecurityEval() {
  const scorer = await loadScorer(INVESTIGATE_SECURITY_EVAL);

  await withBackend(
    {
      projectSeedSql: seedPath(INVESTIGATE_SECURITY_EVAL, 'project.sql'),
      logsSeedJsonl: seedPath(INVESTIGATE_SECURITY_EVAL, 'logs.jsonl'),
    },
    async (backend) => {
      const { rows } = await backend.query(`
SELECT grantee FROM information_schema.role_table_grants
WHERE table_name = 'customer_payment_methods' AND privilege_type = 'SELECT'
ORDER BY grantee;
      `);
      assert(
        (rows as Array<{ grantee: string }>).some(
          (row) => row.grantee === 'anon'
        )
      );

      const report = [
        'customer_payment_methods is exposed to anon.',
        'Fix by REVOKE SELECT ON customer_payment_methods FROM anon and enable row level security.',
      ].join(' ');

      // The judge reads the transcript, so surface the report as assistant text.
      const transcript: TranscriptPart[] = [
        { type: 'message', role: 'assistant', content: report },
      ];

      const result = await scorer(
        scorerCtx(backend, { agentReport: report, transcript })
      );
      assert.equal(result.passed, true, checksMessage(result));
    }
  );

  console.log('PASS investigate security scorer + database shim');
}

async function smokeFrontendBuildTooling() {
  const source = join(ROOT, FRONTEND_EVAL, 'local');
  const workspace = join(
    ROOT,
    'results',
    '_smoke',
    'build-frontend-001-todos-app'
  );
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(dirname(workspace), { recursive: true });
  cpSync(source, workspace, {
    recursive: true,
    filter: (src) => !src.endsWith('/EVAL.ts'),
  });
  cpSync(join(ROOT, FRONTEND_EVAL, 'tests'), join(workspace, 'tests'), {
    recursive: true,
  });
  writeFileSync(join(workspace, 'src', 'App.tsx'), GOOD_FRONTEND_APP);
  writeFileSync(
    join(workspace, 'vite.config.ts'),
    [
      "import { defineConfig } from 'vite';",
      "import react from '@vitejs/plugin-react';",
      '',
      'if (',
      '  process.env.ANTHROPIC_API_KEY ||',
      '  process.env.OPENAI_API_KEY ||',
      '  process.env.AI_GATEWAY_API_KEY',
      ") throw new Error('inherited LLM credential');",
      '',
      'export default defineConfig({ plugins: [react()] });',
      '',
    ].join('\n')
  );
  writeFileSync(
    join(workspace, 'tests', 'environment.test.ts'),
    [
      "import { expect, test } from 'vitest';",
      '',
      "test('does not inherit LLM credentials', () => {",
      '  expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();',
      '  expect(process.env.OPENAI_API_KEY).toBeUndefined();',
      '  expect(process.env.AI_GATEWAY_API_KEY).toBeUndefined();',
      '  // PATH is always set in a real env, so this catches a blocklist regression the checks above would miss.',
      '  expect(process.env.PATH).toBeUndefined();',
      '});',
      '',
    ].join('\n')
  );

  const originalEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
  };
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.AI_GATEWAY_API_KEY = 'test-ai-gateway-key';

  try {
    const build = await viteBuild(workspace);
    assert.equal(build.ok, true, build.stderr || build.stdout);
    const vitest = await vitestRun(workspace);
    assert.equal(vitest.ok, true, vitest.stderr || vitest.stdout);
  } finally {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  console.log('PASS frontend vite/react/supalite build + test tooling');
}

async function main() {
  await smokeClientRlsEval();
  await smokeFunctionsEval();
  await smokeServiceRoleBypassEval();
  await smokeSupaliteClient();
  await smokePlatformBackendClose();
  await smokeEdgeAuthDbEval();
  await smokeLogsSeeding();
  await smokeInvestigateLogsEval();
  await smokeInvestigateSecurityEval();
  await smokeFrontendBuildTooling();
  console.log('PASS framework smoke');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

const ORDER_TOTAL_SOURCE = `
Deno.serve(async (req) => {
  const json = (payload, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (!Array.isArray(body.items) || body.items.length === 0) return json({ error: "items are required" }, 400);

  let subtotal = 0;
  for (const item of body.items) {
    if (!Number.isFinite(item.unit_price_cents) || !Number.isFinite(item.quantity) || item.unit_price_cents <= 0 || item.quantity <= 0) {
      return json({ error: "invalid item" }, 400);
    }
    subtotal += item.unit_price_cents * item.quantity;
  }

  const couponDiscount = body.coupon === "WELCOME10" ? Math.min(Math.round(subtotal * 0.1), 2000) : 0;
  const enterpriseDiscount = body.customer_tier === "enterprise" ? Math.round(subtotal * 0.15) : 0;
  const discount = Math.max(couponDiscount, enterpriseDiscount);
  const taxable = subtotal - discount;
  const tax = Math.round(taxable * 0.0725);

  return json({ subtotal_cents: subtotal, discount_cents: discount, tax_cents: tax, total_cents: taxable + tax });
});
`;

const TODO_CREATE_SOURCE = `
import { createClient } from "@supabase/supabase-js";

Deno.serve(async (req) => {
  const json = (payload, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const authorization = req.headers.get("authorization");
  if (!authorization) return json({ error: "missing authorization" }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (typeof body.body !== "string" || body.body.trim() === "") return json({ error: "body is required" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL"),
    Deno.env.get("SUPABASE_ANON_KEY"),
    { global: { headers: { Authorization: authorization } } }
  );

  const { data, error } = await supabase
    .from("todos")
    .insert({ body: body.body })
    .select("id,body,user_id")
    .single();

  if (error) return json({ error: error.message }, 400);
  return json(data, 201);
});
`;

const GOOD_FRONTEND_APP = `
import { useState } from "react";
import { createClient } from "@supabase/supabase-js";

type Todo = { id: string; body: string; done: boolean };

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export default function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newTodo, setNewTodo] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [error, setError] = useState("");

  async function loadTodos() {
    const { data, error } = await supabase.from("todos").select("id,body,done").order("created_at", { ascending: true });
    if (error) throw error;
    setTodos(data ?? []);
  }

  async function handleSignIn(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { setError(error.message); return; }
    setSignedIn(true);
    await loadTodos();
  }

  async function handleAddTodo(event: React.FormEvent) {
    event.preventDefault();
    const body = newTodo.trim();
    if (!body) return;
    setError("");
    const { data, error } = await supabase.from("todos").insert({ body }).select("id,body,done").single();
    if (error) { setError(error.message); return; }
    setTodos((current) => [...current, data]);
    setNewTodo("");
  }

  async function handleToggleTodo(todo: Todo) {
    setError("");
    const { data, error } = await supabase.from("todos").update({ done: !todo.done }).eq("id", todo.id).select("id,body,done").single();
    if (error) { setError(error.message); return; }
    setTodos((current) => current.map((item) => (item.id === todo.id ? data : item)));
  }

  return (
    <main>
      <h1>Todos</h1>
      <form onSubmit={handleSignIn}>
        <input data-testid="email-input" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input data-testid="password-input" placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button data-testid="sign-in-button" type="submit">Sign in</button>
      </form>
      {signedIn ? <p data-testid="signed-in">Signed in</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <form onSubmit={handleAddTodo}>
        <input data-testid="todo-input" placeholder="New todo" value={newTodo} onChange={(e) => setNewTodo(e.target.value)} />
        <button data-testid="add-button" type="submit">Add</button>
      </form>
      <ul data-testid="todo-list">
        {todos.map((todo) => (
          <li key={todo.id}>
            <label>
              <input data-testid={\`todo-checkbox-\${todo.body}\`} type="checkbox" checked={todo.done} onChange={() => void handleToggleTodo(todo)} />
              {todo.body}
            </label>
          </li>
        ))}
      </ul>
    </main>
  );
}
`;
