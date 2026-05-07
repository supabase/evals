import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootPlatformBackend } from "../harness/platform-backend.js";
import { viteBuild, vitestRun } from "../harness/project-runner.js";
import type { ToolScorer } from "../harness/types.js";
import type { PlatformBackend } from "../harness/platform-backend.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const DESIGN_EVAL = "evals/design-rls-001-tenant-isolation";
const CLIENT_RLS_EVAL = "evals/design-rls-002-own-todos-client";
const FUNCTIONS_EVAL = "evals/design-functions-001-order-total";
const EDGE_AUTH_DB_EVAL = "evals/design-functions-002-edge-auth-db";
const OBSERVE_EVAL = "evals/observe-logs-001-top-error-function";
const DETECT_EVAL = "evals/detect-security-001-public-table";
const FRONTEND_EVAL = "evals/design-frontend-001-todos-app";

async function loadScorer(relDir: string): Promise<ToolScorer> {
  const mod = await import(pathToFileURL(join(ROOT, relDir, "EVAL.ts")).href);
  return mod.default as ToolScorer;
}

function scorerCtx(backend: PlatformBackend, extra?: { agentReport?: string }) {
  return {
    mgmt: backend.mgmt,
    ref: backend.ref,
    client: backend.client,
    getClient: backend.getClient,
    query: backend.query,
    invokeFunction: backend.invokeFunction,
    toolCalls: [] as never[],
    agentReport: extra?.agentReport,
  };
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

async function smokeDesignEval() {
  const scorer = await loadScorer(DESIGN_EVAL);

  await withBackend(
    { projectSeedSql: seedPath(DESIGN_EVAL, "project.sql") },
    async (backend) => {
      const before = await scorer(scorerCtx(backend));
      assert.equal(before.passed, false);
      assert.match(before.notes ?? "", /RLS not enabled/i);

      await backend.query(`
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON memberships TO authenticated;
GRANT SELECT, INSERT ON notes TO authenticated;

CREATE POLICY "members can read notes in their orgs"
ON notes FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM memberships
    WHERE memberships.org_id = notes.org_id
      AND memberships.user_id = auth.uid()
  )
);

CREATE POLICY "members can insert their own notes in their orgs"
ON notes FOR INSERT TO authenticated
WITH CHECK (
  author_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM memberships
    WHERE memberships.org_id = notes.org_id
      AND memberships.user_id = auth.uid()
  )
);

CREATE POLICY "authors can update their own notes"
ON notes FOR UPDATE TO authenticated
USING (author_id = auth.uid())
WITH CHECK (
  author_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM memberships
    WHERE memberships.org_id = notes.org_id
      AND memberships.user_id = auth.uid()
  )
);

CREATE POLICY "authors can delete their own notes"
ON notes FOR DELETE TO authenticated
USING (author_id = auth.uid());
      `);

      const after = await scorer(scorerCtx(backend));
      assert.equal(after.passed, true, after.notes);
    }
  );

  console.log("PASS design scorer + platform-backend dispatcher");
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

      const score = await scorer(scorerCtx(backend));
      assert.equal(score.passed, true, score.notes);
    }
  );

  console.log("PASS client-scored RLS scorer + supabase-js");
}

async function smokeFunctionsEval() {
  const scorer = await loadScorer(FUNCTIONS_EVAL);

  await withBackend({}, async (backend) => {
    const before = await scorer(scorerCtx(backend));
    assert.equal(before.passed, false);
    assert.match(before.notes ?? "", /function not found/i);

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
    assert.equal(after.passed, true, after.notes);
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

      const score = await scorer(scorerCtx(backend));
      assert.equal(score.passed, true, score.notes);
    }
  );

  console.log("PASS edge function auth + supabase-js DB scorer");
}

async function smokeLogsSeeding() {
  await withBackend(
    { logsSeedJsonl: seedPath(OBSERVE_EVAL, "logs.jsonl") },
    async ({ url, ref, accessToken }) => {
      const logsUrl = `${url}/v1/projects/${ref}/analytics/endpoints/logs.all?sql=${encodeURIComponent("SELECT count(*)::int AS n FROM edge_logs")}`;
      const res = await fetch(logsUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      const body = await res.json() as { result: Array<{ n: number }> };
      assert(body.result[0] && body.result[0].n > 0, "expected seeded logs");
    }
  );

  console.log("PASS logs seeding via platform-lite");
}

async function smokeObserveEval() {
  const scorer = await loadScorer(OBSERVE_EVAL);

  await withBackend(
    { logsSeedJsonl: seedPath(OBSERVE_EVAL, "logs.jsonl") },
    async (backend) => {
      const score = await scorer(
        scorerCtx(backend, { agentReport: "stripe-webhook had the most errors with 9 errors out of 50 events." })
      );
      assert.equal(score.passed, true, score.notes);
    }
  );

  console.log("PASS observe scorer");
}

async function smokeDetectEval() {
  const scorer = await loadScorer(DETECT_EVAL);

  await withBackend(
    {
      projectSeedSql: seedPath(DETECT_EVAL, "project.sql"),
      logsSeedJsonl: seedPath(DETECT_EVAL, "logs.jsonl"),
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

      const score = await scorer(scorerCtx(backend, { agentReport: report }));
      assert.equal(score.passed, true, score.notes);
    }
  );

  console.log("PASS detect scorer + database shim");
}

async function smokeProjectEval() {
  const source = join(ROOT, FRONTEND_EVAL, "app");
  const workspace = join(ROOT, "results", "_smoke", "design-frontend-001-todos-app");
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
  await smokeDesignEval();
  await smokeClientRlsEval();
  await smokeFunctionsEval();
  await smokeSupaliteClient();
  await smokePlatformBackendClose();
  await smokeEdgeAuthDbEval();
  await smokeLogsSeeding();
  await smokeObserveEval();
  await smokeDetectEval();
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
