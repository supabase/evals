import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootPlatformBackend } from "../harness/platform-backend.js";
import { viteBuild, vitestRun } from "../harness/project-runner.js";
import type { ToolScorer, TranscriptPart } from "../harness/types.js";
import type { PlatformBackend } from "../harness/platform-backend.js";
import { runScorer } from "../lib/scorer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const CLIENT_RLS_EVAL = "evals/build-rls-002-own-todos-client";
const VECTORS_EVAL = "evals/build-vectors-001-rag-with-permissions";
const FUNCTIONS_EVAL = "evals/build-functions-001-order-total";
const EDGE_AUTH_DB_EVAL = "evals/build-functions-002-edge-auth-db";
const INVESTIGATE_LOGS_EVAL = "evals/investigate-logs-001-top-error-function";
const INVESTIGATE_SECURITY_EVAL = "evals/investigate-security-001-public-table";
const FRONTEND_EVAL = "evals/build-frontend-001-todos-app";

async function loadScorer(relDir: string): Promise<ToolScorer> {
  const mod = await import(pathToFileURL(join(ROOT, relDir, "EVAL.ts")).href);
  const scorer = mod.default as ToolScorer;
  // Route scorers through the same silencing wrapper the runner uses, so smoke
  // runs stay quiet on expected-fail supabase-js calls.
  return (ctx) => runScorer(() => scorer(ctx));
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
  return join(ROOT, relDir, "seed", file);
}

async function smokeClientRlsEval() {
  const scorer = await loadScorer(CLIENT_RLS_EVAL);

  await withBackend(
    { projectSeedSql: seedPath(CLIENT_RLS_EVAL, "project.sql") },
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

  console.log("PASS client-scored RLS scorer + supabase-js");
}

const VECTORS_GOLDEN_SQL = `
CREATE EXTENSION vector WITH SCHEMA extensions;

ALTER TABLE document_sections ADD COLUMN embedding extensions.vector(384);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_sections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users can read own documents" ON documents FOR SELECT TO authenticated
  USING (owner_id = (SELECT auth.uid()));
CREATE POLICY "users can read own document sections" ON document_sections FOR SELECT TO authenticated
  USING (document_id IN (SELECT id FROM documents WHERE owner_id = (SELECT auth.uid())));

CREATE INDEX ON document_sections USING hnsw (embedding extensions.vector_ip_ops);

CREATE FUNCTION match_document_sections(query_embedding extensions.vector(384), match_count int)
RETURNS SETOF document_sections
LANGUAGE sql
AS $fn$
  SELECT * FROM document_sections
  ORDER BY embedding OPERATOR(extensions.<#>) query_embedding
  LIMIT match_count;
$fn$;
`;

async function smokeVectorsEval() {
  const scorer = await loadScorer(VECTORS_EVAL);

  await withBackend(
    { projectSeedSql: seedPath(VECTORS_EVAL, "project.sql") },
    async (backend) => {
      await backend.query(VECTORS_GOLDEN_SQL);
      const result = await scorer(scorerCtx(backend));
      assert.equal(result.passed, true, checksMessage(result));
    }
  );

  // SECURITY DEFINER match function bypasses RLS; the leak checks must fail.
  await withBackend(
    { projectSeedSql: seedPath(VECTORS_EVAL, "project.sql") },
    async (backend) => {
      await backend.query(
        VECTORS_GOLDEN_SQL.replace("LANGUAGE sql", "LANGUAGE sql SECURITY DEFINER")
      );
      const result = await scorer(scorerCtx(backend));
      assert.equal(result.passed, false, "security definer leak should fail the scorer");
      const failed = (result.checks ?? []).filter((check) => !check.passed);
      assert(
        failed.some((check) => check.name.includes("user A search")),
        `expected the user A leak check to fail, got: ${checksMessage(result)}`
      );
    }
  );

  console.log("PASS vectors RAG-with-permissions scorer + pgvector");
}

async function smokeFunctionsEval() {
  const scorer = await loadScorer(FUNCTIONS_EVAL);

  await withBackend({}, async (backend) => {
    const before = await scorer(scorerCtx(backend));
    assert.equal(before.passed, false);
    assert.match(checksMessage(before), /function not found/i);

    const deployUrl = `${backend.url}/v1/projects/${backend.ref}/functions/deploy?slug=order-total`;
    const form = new FormData();
    form.append("metadata", JSON.stringify({ name: "order-total", verify_jwt: false, entrypoint_path: "index.ts" }));
    form.append("file", new File([ORDER_TOTAL_SOURCE], "index.ts", { type: "application/typescript" }));

    const deployRes = await fetch(deployUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${backend.accessToken}` },
      body: form,
    });
    assert.equal(deployRes.status, 201, `deploy failed: ${await deployRes.text()}`);

    const after = await scorer(scorerCtx(backend));
    assert.equal(after.passed, true, checksMessage(after));
  });

  console.log("PASS functions scorer + edge-functions dispatcher");
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
      password: "secret123",
    });
    assert.equal(signupError, null);
    assert(signup.user?.id);

    const { error: insertError } = await client.from("todos").insert({
      user_id: signup.user.id,
      body: "verify supabase-js path",
    });
    assert.equal(insertError, null);

    const { data: rows, error: selectError } = await client
      .from("todos")
      .select("body")
      .eq("user_id", signup.user.id);
    assert.equal(selectError, null);
    assert.deepEqual(rows, [{ body: "verify supabase-js path" }]);
  });

  console.log("PASS supalite auth + supabase-js client");
}

async function smokePlatformBackendClose() {
  const backend = await bootPlatformBackend({});
  await backend.query("select 1 as n");
  await backend.close();
  await assert.rejects(() => backend.query("select 1 as n"));
  await backend.close();

  console.log("PASS platform backend close disposes platform");
}

async function smokeEdgeAuthDbEval() {
  const scorer = await loadScorer(EDGE_AUTH_DB_EVAL);

  await withBackend(
    { projectSeedSql: seedPath(EDGE_AUTH_DB_EVAL, "project.sql") },
    async (backend) => {
      // Deploy the function via platform-lite's HTTP management API
      const deployUrl = `${backend.url}/v1/projects/${backend.ref}/functions/deploy?slug=todo-create`;
      const form = new FormData();
      form.append("metadata", JSON.stringify({ name: "todo-create", verify_jwt: true, entrypoint_path: "index.ts" }));
      form.append("file", new File([TODO_CREATE_SOURCE], "index.ts", { type: "application/typescript" }));

      const deployRes = await fetch(deployUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${backend.accessToken}` },
        body: form,
      });
      assert.equal(deployRes.status, 201, `deploy failed: ${await deployRes.text()}`);

      const result = await scorer(scorerCtx(backend));
      assert.equal(result.passed, true, checksMessage(result));
    }
  );

  console.log("PASS edge function auth + supabase-js DB scorer");
}

async function smokeLogsSeeding() {
  await withBackend(
    { logsSeedJsonl: seedPath(INVESTIGATE_LOGS_EVAL, "logs.jsonl") },
    async ({ url, ref, accessToken }) => {
      const logsUrl = `${url}/v1/projects/${ref}/analytics/endpoints/logs.all?sql=${encodeURIComponent("SELECT count(*)::int AS n FROM edge_logs")}`;
      const res = await fetch(logsUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      const body = await res.json() as { result: Array<{ n: number }> };
      assert(body.result[0] && body.result[0].n > 0, "expected seeded logs");
    }
  );

  console.log("PASS logs seeding via platform-lite");
}

async function smokeInvestigateLogsEval() {
  const scorer = await loadScorer(INVESTIGATE_LOGS_EVAL);

  await withBackend(
    { logsSeedJsonl: seedPath(INVESTIGATE_LOGS_EVAL, "logs.jsonl") },
    async (backend) => {
      const result = await scorer(
        scorerCtx(backend, { agentReport: "stripe-webhook had the most errors with 9 errors out of 50 events." })
      );
      assert.equal(result.passed, true, checksMessage(result));
    }
  );

  console.log("PASS investigate logs scorer");
}

async function smokeInvestigateSecurityEval() {
  const scorer = await loadScorer(INVESTIGATE_SECURITY_EVAL);

  await withBackend(
    {
      projectSeedSql: seedPath(INVESTIGATE_SECURITY_EVAL, "project.sql"),
      logsSeedJsonl: seedPath(INVESTIGATE_SECURITY_EVAL, "logs.jsonl"),
    },
    async (backend) => {
      const { rows } = await backend.query(`
SELECT grantee FROM information_schema.role_table_grants
WHERE table_name = 'customer_payment_methods' AND privilege_type = 'SELECT'
ORDER BY grantee;
      `);
      assert((rows as Array<{ grantee: string }>).some((row) => row.grantee === "anon"));

      const report = [
        "customer_payment_methods is exposed to anon.",
        "Fix by REVOKE SELECT ON customer_payment_methods FROM anon and enable row level security.",
      ].join(" ");

      // The judge reads the transcript, so surface the report as assistant text.
      const transcript: TranscriptPart[] = [
        { type: "message", role: "assistant", content: report },
      ];

      const result = await scorer(
        scorerCtx(backend, { agentReport: report, transcript })
      );
      assert.equal(result.passed, true, checksMessage(result));
    }
  );

  console.log("PASS investigate security scorer + database shim");
}

async function smokeProjectEval() {
  const source = join(ROOT, FRONTEND_EVAL, "app");
  const workspace = join(ROOT, "results", "_smoke", "build-frontend-001-todos-app");
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(dirname(workspace), { recursive: true });
  cpSync(source, workspace, {
    recursive: true,
    filter: (src) => !src.endsWith("/EVAL.ts"),
  });
  cpSync(join(ROOT, FRONTEND_EVAL, "tests"), join(workspace, "tests"), { recursive: true });
  writeFileSync(
    join(workspace, ".env.local"),
    ["VITE_SUPABASE_URL=http://supabase-evals.local", "VITE_SUPABASE_ANON_KEY=supabase-evals-anon-key", ""].join("\n")
  );
  writeFileSync(join(workspace, "src", "App.tsx"), GOOD_FRONTEND_APP);

  const build = await viteBuild(workspace);
  assert.equal(build.ok, true, build.stderr || build.stdout);
  const vitest = await vitestRun(workspace);
  assert.equal(vitest.ok, true, vitest.stderr || vitest.stdout);

  console.log("PASS project-mode vite/react/supalite scorer");
}

async function main() {
  await smokeClientRlsEval();
  await smokeVectorsEval();
  await smokeFunctionsEval();
  await smokeSupaliteClient();
  await smokePlatformBackendClose();
  await smokeEdgeAuthDbEval();
  await smokeLogsSeeding();
  await smokeInvestigateLogsEval();
  await smokeInvestigateSecurityEval();
  await smokeProjectEval();
  console.log("PASS framework smoke");
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
