import type { CheckResult, ToolScorer } from "@supabase-evals/core";

const FUNCTION_NAME = "todos-api";
const PASSWORD = "secret123";

interface InvokeResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const parseJson = (result: InvokeResult) => {
  try {
    return JSON.parse(result.body) as Record<string, any>;
  } catch {
    return undefined;
  }
};

const rowFrom = (json: Record<string, any> | undefined) => json?.todo ?? json;

const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [];

  try {
    const clientA = ctx.client;
    const clientB = ctx.getClient();

    const { data: authA, error: authAError } = await clientA.auth.signUp({
      email: `todos-api-a-${Date.now()}@example.com`,
      password: PASSWORD,
    });
    const { data: authB, error: authBError } = await clientB.auth.signUp({
      email: `todos-api-b-${Date.now()}@example.com`,
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
      return {
        passed: false,
        checks: [
          {
            name: "created auth sessions",
            passed: false,
            notes: authAError?.message ?? authBError?.message ?? "missing session",
          },
        ],
      };
    }

    const invoke = (input: {
      method?: string;
      path?: string;
      headers?: Record<string, string>;
      body?: unknown;
    }) =>
      ctx.invokeFunction({
        name: FUNCTION_NAME,
        ...input,
      }) as Promise<InvokeResult>;

    const authHeadersA = { authorization: `Bearer ${authA.session.access_token}` };
    const authHeadersB = { authorization: `Bearer ${authB.session.access_token}` };

    const missingAuth = await invoke({ method: "GET" });
    checks.push({ name: "rejects missing auth", passed: missingAuth.status === 401 });

    const badLimit = await invoke({
      method: "GET",
      path: "?limit=200",
      headers: authHeadersA,
    });
    checks.push({ name: "rejects invalid limit", passed: badLimit.status === 400 });

    const invalidJson = await invoke({
      method: "POST",
      headers: authHeadersA,
      body: "{",
    });
    checks.push({ name: "rejects invalid JSON", passed: invalidJson.status === 400 });

    const created = await invoke({
      method: "POST",
      headers: authHeadersA,
      body: { body: "buy milk", done: false },
    });
    const createdRow = rowFrom(parseJson(created));
    checks.push({
      name: "creates todo for authenticated user",
      passed:
        created.status === 201 &&
        createdRow?.body === "buy milk" &&
        createdRow?.user_id === authA.user.id &&
        typeof createdRow?.id === "string",
    });

    await invoke({
      method: "POST",
      headers: authHeadersA,
      body: { body: "done item", done: true },
    });

    const listDone = await invoke({
      method: "GET",
      path: "?done=true&limit=10",
      headers: authHeadersA,
    });
    const listJson = parseJson(listDone);
    const todos = Array.isArray(listJson) ? listJson : listJson?.todos;
    checks.push({
      name: "filters todos by done",
      passed:
        listDone.status === 200 &&
        Array.isArray(todos) &&
        todos.length === 1 &&
        todos[0]?.body === "done item" &&
        todos[0]?.done === true,
    });

    const invalidUuid = await invoke({
      method: "PATCH",
      path: "/not-a-uuid",
      headers: authHeadersA,
      body: { done: true },
    });
    checks.push({ name: "rejects invalid UUID", passed: invalidUuid.status === 400 });

    const patchOtherUser = await invoke({
      method: "PATCH",
      path: `/${createdRow?.id}`,
      headers: authHeadersB,
      body: { body: "stolen" },
    });
    checks.push({
      name: "returns 404 when patching another user's todo",
      passed: patchOtherUser.status === 404,
    });

    const ownPatch = await invoke({
      method: "PATCH",
      path: `/${createdRow?.id}`,
      headers: authHeadersA,
      body: { done: true },
    });
    const ownPatchRow = rowFrom(parseJson(ownPatch));
    checks.push({
      name: "updates own todo",
      passed: ownPatch.status === 200 && ownPatchRow?.id === createdRow?.id && ownPatchRow?.done === true,
    });

    const deleteOtherUser = await invoke({
      method: "DELETE",
      path: `/${createdRow?.id}`,
      headers: authHeadersB,
    });
    checks.push({
      name: "returns 404 when deleting another user's todo",
      passed: deleteOtherUser.status === 404,
    });

    const ownDelete = await invoke({
      method: "DELETE",
      path: `/${createdRow?.id}`,
      headers: authHeadersA,
    });
    checks.push({
      name: "deletes own todo",
      passed: ownDelete.status === 200 && parseJson(ownDelete)?.deleted === true,
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

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
};

export default scorer;
