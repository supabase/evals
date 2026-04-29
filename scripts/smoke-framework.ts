import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootMgmtApi, type MgmtApiHandle } from "../shims/management-api.js";
import { buildTools } from "../harness/tool-surface.js";
import type { Scorer, ToolCallRecord } from "../harness/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const DESIGN_EVAL = "evals/design-rls-001-tenant-isolation";
const CLIENT_RLS_EVAL = "evals/design-rls-002-own-todos-client";
const FUNCTIONS_EVAL = "evals/design-functions-001-order-total";
const EDGE_AUTH_DB_EVAL = "evals/design-functions-002-edge-auth-db";
const DETECT_EVAL = "evals/detect-security-001-public-table";
const NOTIFY_EVAL = "evals/notify-001-error-spike";

async function loadScorer(relDir: string): Promise<Scorer> {
  const mod = await import(pathToFileURL(join(ROOT, relDir, "EVAL.ts")).href);
  return mod.default as Scorer;
}

async function withMgmt<T>(
  opts: { projectSeedSql?: string; logsSeedNdjson?: string },
  fn: (mgmt: MgmtApiHandle) => Promise<T>
): Promise<T> {
  const mgmt = await bootMgmtApi(opts);
  try {
    return await fn(mgmt);
  } finally {
    await mgmt.close();
  }
}

function seedPath(relDir: string, file: string): string {
  return join(ROOT, relDir, "seed", file);
}

async function smokeToolSurface() {
  await withMgmt({}, async (mgmt) => {
    const { tools, resolve } = buildTools(mgmt, [
      "database.query",
      "functions.deploy",
      "notifications.send",
    ]);
    assert.deepEqual(
      Object.keys(tools).sort(),
      ["database_query", "functions_deploy", "notifications_send"]
    );
    assert.equal(resolve("database_query"), "database.query");
    assert.equal(resolve("functions_deploy"), "functions.deploy");
    assert.equal(resolve("notifications_send"), "notifications.send");
    assert.equal(resolve("logs_all"), undefined);
  });
  console.log("PASS tool surface");
}

async function smokeDesignEval() {
  const scorer = await loadScorer(DESIGN_EVAL);

  await withMgmt(
    { projectSeedSql: seedPath(DESIGN_EVAL, "project.sql") },
    async (mgmt) => {
      const before = await scorer({ mgmt, client: mgmt.backends.projectDb.client, toolCalls: [] });
      assert.equal(before.passed, false);
      assert.match(before.notes ?? "", /RLS not enabled/i);

      await mgmt.call("database.query", {
        query: `
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON memberships TO authenticated;
GRANT SELECT, INSERT ON notes TO authenticated;

CREATE POLICY "members can read notes in their orgs"
ON notes
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM memberships
    WHERE memberships.org_id = notes.org_id
      AND memberships.user_id = auth.uid()
  )
);

CREATE POLICY "members can insert their own notes in their orgs"
ON notes
FOR INSERT
TO authenticated
WITH CHECK (
  author_id = auth.uid()
  AND EXISTS (
    SELECT 1
    FROM memberships
    WHERE memberships.org_id = notes.org_id
      AND memberships.user_id = auth.uid()
  )
);

CREATE POLICY "authors can update their own notes"
ON notes
FOR UPDATE
TO authenticated
USING (author_id = auth.uid())
WITH CHECK (
  author_id = auth.uid()
  AND EXISTS (
    SELECT 1
    FROM memberships
    WHERE memberships.org_id = notes.org_id
      AND memberships.user_id = auth.uid()
  )
);

CREATE POLICY "authors can delete their own notes"
ON notes
FOR DELETE
TO authenticated
USING (author_id = auth.uid());
        `,
      });

      const after = await scorer({ mgmt, client: mgmt.backends.projectDb.client, toolCalls: [] });
      assert.equal(after.passed, true, after.notes);
    }
  );

  console.log("PASS design scorer + project-db dispatcher");
}

async function smokeClientRlsEval() {
  const scorer = await loadScorer(CLIENT_RLS_EVAL);

  await withMgmt(
    { projectSeedSql: seedPath(CLIENT_RLS_EVAL, "project.sql") },
    async (mgmt) => {
      await mgmt.call("database.query", {
        query: `
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users can read own todos"
ON todos
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "users can insert own todos"
ON todos
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

CREATE POLICY "users can update own todos"
ON todos
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE POLICY "users can delete own todos"
ON todos
FOR DELETE
TO authenticated
USING (user_id = auth.uid());
        `,
      });

      const score = await scorer({
        mgmt,
        client: mgmt.backends.projectDb.client,
        toolCalls: [],
      });
      assert.equal(score.passed, true, score.notes);
    }
  );

  console.log("PASS client-scored RLS scorer + supabase-js");
}

async function smokeFunctionsEval() {
  const scorer = await loadScorer(FUNCTIONS_EVAL);

  await withMgmt({}, async (mgmt) => {
    const before = await scorer({ mgmt, client: mgmt.backends.projectDb.client, toolCalls: [] });
    assert.equal(before.passed, false);
    assert.match(before.notes ?? "", /function not found/i);

    await mgmt.call("functions.deploy", {
      slug: "order-total",
      metadata: {
        name: "order-total",
        verify_jwt: false,
        entrypoint_path: "index.ts",
      },
      file: [`
Deno.serve(async (req) => {
  const json = (payload, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });

  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return json({ error: "items are required" }, 400);
  }

  let subtotal = 0;
  for (const item of body.items) {
    if (
      !Number.isFinite(item.unit_price_cents) ||
      !Number.isFinite(item.quantity) ||
      item.unit_price_cents <= 0 ||
      item.quantity <= 0
    ) {
      return json({ error: "invalid item" }, 400);
    }
    subtotal += item.unit_price_cents * item.quantity;
  }

  const couponDiscount =
    body.coupon === "WELCOME10" ? Math.min(Math.round(subtotal * 0.1), 2000) : 0;
  const enterpriseDiscount =
    body.customer_tier === "enterprise" ? Math.round(subtotal * 0.15) : 0;
  const discount = Math.max(couponDiscount, enterpriseDiscount);
  const taxable = subtotal - discount;
  const tax = Math.round(taxable * 0.0725);

  return json({
    subtotal_cents: subtotal,
    discount_cents: discount,
    tax_cents: tax,
    total_cents: taxable + tax,
  });
});
      `],
    });

    const after = await scorer({ mgmt, client: mgmt.backends.projectDb.client, toolCalls: [] });
    assert.equal(after.passed, true, after.notes);
  });

  console.log("PASS functions scorer + edge-functions dispatcher");
}

async function smokeSupaliteClient() {
  await withMgmt({}, async (mgmt) => {
    await mgmt.call("database.query", {
      query: `
CREATE TABLE todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  body text NOT NULL
);

ALTER TABLE todos ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON todos TO authenticated;

CREATE POLICY "users can insert their own todos"
ON todos
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

CREATE POLICY "users can read their own todos"
ON todos
FOR SELECT
TO authenticated
USING (user_id = auth.uid());
      `,
    });

    const client = mgmt.backends.projectDb.client;
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

async function smokeEdgeAuthDbEval() {
  const scorer = await loadScorer(EDGE_AUTH_DB_EVAL);

  await withMgmt(
    { projectSeedSql: seedPath(EDGE_AUTH_DB_EVAL, "project.sql") },
    async (mgmt) => {
      await mgmt.call("functions.deploy", {
        slug: "todo-create",
        metadata: {
          name: "todo-create",
          verify_jwt: true,
          entrypoint_path: "index.ts",
        },
        file: [`
import { createClient } from "@supabase/supabase-js";

Deno.serve(async (req) => {
  const json = (payload, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });

  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const authorization = req.headers.get("authorization");
  if (!authorization) {
    return json({ error: "missing authorization" }, 401);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  if (typeof body.body !== "string" || body.body.trim() === "") {
    return json({ error: "body is required" }, 400);
  }

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

  if (error) {
    return json({ error: error.message }, 400);
  }

  return json(data, 201);
});
        `],
      });

      const score = await scorer({
        mgmt,
        client: mgmt.backends.projectDb.client,
        toolCalls: [],
      });
      assert.equal(score.passed, true, score.notes);
    }
  );

  console.log("PASS edge function auth + supabase-js DB scorer");
}

async function smokeDetectEval() {
  const scorer = await loadScorer(DETECT_EVAL);

  await withMgmt(
    {
      projectSeedSql: seedPath(DETECT_EVAL, "project.sql"),
      logsSeedNdjson: seedPath(DETECT_EVAL, "logs.ndjson"),
    },
    async (mgmt) => {
      const grant = (await mgmt.call("database.query", {
        query: `
SELECT grantee
FROM information_schema.role_table_grants
WHERE table_name = 'customer_payment_methods'
  AND privilege_type = 'SELECT'
ORDER BY grantee;
        `,
      })) as { rows: Array<{ grantee: string }> };
      assert(grant.rows.some((row) => row.grantee === "anon"));

      const logs = (await mgmt.call("logs.all", {
        sql: "SELECT count(*)::int AS n FROM logs;",
      })) as { rows: Array<{ n: number }> };
      assert(logs.rows[0]?.n > 0);

      const report = [
        "customer_payment_methods is exposed to anon.",
        "Fix by REVOKE SELECT ON customer_payment_methods FROM anon and enable row level security.",
      ].join(" ");

      const score = await scorer({
        mgmt,
        client: mgmt.backends.projectDb.client,
        toolCalls: [],
        agentReport: report,
      });
      assert.equal(score.passed, true, score.notes);
    }
  );

  console.log("PASS detect scorer + logs/database shims");
}

async function smokeNotifyEval() {
  const scorer = await loadScorer(NOTIFY_EVAL);

  await withMgmt(
    { logsSeedNdjson: seedPath(NOTIFY_EVAL, "logs.ndjson") },
    async (mgmt) => {
      const stats = (await mgmt.call("logs.all", {
        sql: `
SELECT
  metadata->>'function_id' AS function_id,
  SUM((level = 'error')::int)::float / COUNT(*)::float AS error_rate
FROM logs
WHERE metadata->>'function_id' = 'process-payment'
GROUP BY 1;
        `,
      })) as { rows: Array<{ function_id: string; error_rate: number }> };

      assert.equal(stats.rows[0]?.function_id, "process-payment");
      assert(Number(stats.rows[0]?.error_rate) > 0.05);

      const toolCalls: ToolCallRecord[] = [
        {
          endpoint: "notifications.send",
          body: {
            channel: "pagerduty",
            severity: "high",
            payload: {
              function_id: stats.rows[0]?.function_id,
              error_rate: Number(stats.rows[0]?.error_rate),
            },
          },
          ts: Date.now(),
        },
      ];

      const result = await mgmt.call("notifications.send", toolCalls[0].body);
      toolCalls[0].result = result;

      const score = await scorer({ mgmt, client: mgmt.backends.projectDb.client, toolCalls });
      assert.equal(score.passed, true, score.notes);
    }
  );

  console.log("PASS notify scorer + notifications recorder");
}

async function main() {
  await smokeToolSurface();
  await smokeDesignEval();
  await smokeClientRlsEval();
  await smokeFunctionsEval();
  await smokeSupaliteClient();
  await smokeEdgeAuthDbEval();
  await smokeDetectEval();
  await smokeNotifyEval();
  console.log("PASS framework smoke");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
