import type { Scorer } from "../../apps/framework/harness/types.js";

const FUNCTION_NAME = "todo-create";
const TODO_BODY = "verify edge auth database integration";

interface InvokeResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const parseJson = (result: InvokeResult) => {
  try {
    return JSON.parse(result.body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const scorer: Scorer = async (ctx) => {
  const checks: Array<{ name: string; ok: boolean }> = [];

  try {
    const { data: signup, error: signupError } = await ctx.client.auth.signUp({
      email: `todo-create-${Date.now()}@example.com`,
      password: "secret123",
    });
    if (signupError || !signup.user || !signup.session?.access_token) {
      return {
        passed: false,
        score: 0,
        notes: `could not create auth session: ${signupError?.message ?? "missing session"}`,
      };
    }

    const missingAuth = (await ctx.mgmt.backends.edgeFunctions.invoke({
      name: FUNCTION_NAME,
      method: "POST",
      body: { body: TODO_BODY },
    })) as InvokeResult;
    checks.push({
      name: "rejects missing auth",
      ok: missingAuth.status >= 400,
    });

    const inserted = (await ctx.mgmt.backends.edgeFunctions.invoke({
      name: FUNCTION_NAME,
      method: "POST",
      headers: {
        authorization: `Bearer ${signup.session.access_token}`,
      },
      body: { body: TODO_BODY },
    })) as InvokeResult;
    const insertedJson = parseJson(inserted);
    checks.push({
      name: "authenticated request succeeds",
      ok: inserted.status === 201 || inserted.status === 200,
    });
    checks.push({
      name: "returns inserted todo body",
      ok: insertedJson?.body === TODO_BODY || (insertedJson?.todo as any)?.body === TODO_BODY,
    });

    const { data: todos, error: selectError } = await ctx.client
      .from("todos")
      .select("body,user_id")
      .eq("body", TODO_BODY);
    checks.push({
      name: "row exists through supabase-js",
      ok:
        !selectError &&
        Array.isArray(todos) &&
        todos.length === 1 &&
        todos[0]?.body === TODO_BODY &&
        todos[0]?.user_id === signup.user.id,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      score: checks.filter((c) => c.ok).length / 4,
      notes: [
        ...checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`),
        `FAIL scorer could not evaluate ${FUNCTION_NAME}: ${msg}`,
      ].join("\n"),
    };
  }

  const passed = checks.every((c) => c.ok);
  return {
    passed,
    score: checks.filter((c) => c.ok).length / checks.length,
    notes: checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`).join("\n"),
  };
};

export default scorer;
