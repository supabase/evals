import {
  unwrapEdgeFunctionResponse,
  type CheckResult,
  type ToolScorer,
} from "@supabase-evals/core";

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

const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [];

  try {
    const { data: signup, error: signupError } = await ctx.client.auth.signUp({
      email: `todo-create-${Date.now()}@example.com`,
      password: "secret123",
    });
    if (signupError || !signup.user || !signup.session?.access_token) {
      return {
        passed: false,
        checks: [
          {
            name: "created auth session",
            passed: false,
            notes: signupError?.message ?? "missing session",
          },
        ],
      };
    }

    const missingAuth = unwrapEdgeFunctionResponse(
      await ctx.invokeFunction({
        name: FUNCTION_NAME,
        method: "POST",
        body: { body: TODO_BODY },
      })
    );
    checks.push({
      name: "rejects missing auth",
      passed: missingAuth.status >= 400,
    });

    const inserted = unwrapEdgeFunctionResponse(
      await ctx.invokeFunction({
        name: FUNCTION_NAME,
        method: "POST",
        headers: {
          authorization: `Bearer ${signup.session.access_token}`,
        },
        body: { body: TODO_BODY },
      })
    );
    const insertedJson = parseJson(inserted);
    checks.push({
      name: "authenticated request succeeds",
      passed: inserted.status === 201 || inserted.status === 200,
    });
    checks.push({
      name: "returns inserted todo body",
      passed: insertedJson?.body === TODO_BODY || (insertedJson?.todo as any)?.body === TODO_BODY,
    });

    const { data: todos, error: selectError } = await ctx.client
      .from("todos")
      .select("body,user_id")
      .eq("body", TODO_BODY);
    checks.push({
      name: "row exists through supabase-js",
      passed:
        !selectError &&
        Array.isArray(todos) &&
        todos.length === 1 &&
        todos[0]?.body === TODO_BODY &&
        todos[0]?.user_id === signup.user.id,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      name: `scorer evaluated ${FUNCTION_NAME}`,
      passed: false,
      notes: msg,
    });
    return {
      passed: false,
      checks,
    };
  }

  const passed = checks.every((check) => check.passed);
  return {
    passed,
    checks,
  };
};

export default scorer;
