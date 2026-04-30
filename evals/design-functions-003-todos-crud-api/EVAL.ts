import type { Scorer } from "../../harness/types.js";

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

const scorer: Scorer = async (ctx) => {
  const checks: Array<{ name: string; ok: boolean }> = [];

  try {
    const clientA = ctx.client;
    const clientB = ctx.mgmt.backends.projectDb.app.getClient();

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
        score: 0,
        notes: `could not create auth sessions: ${
          authAError?.message ?? authBError?.message ?? "missing session"
        }`,
      };
    }

    const invoke = (input: {
      method?: string;
      path?: string;
      headers?: Record<string, string>;
      body?: unknown;
    }) =>
      ctx.mgmt.backends.edgeFunctions.invoke({
        name: FUNCTION_NAME,
        ...input,
      }) as Promise<InvokeResult>;

    const authHeadersA = { authorization: `Bearer ${authA.session.access_token}` };
    const authHeadersB = { authorization: `Bearer ${authB.session.access_token}` };

    const missingAuth = await invoke({ method: "GET" });
    checks.push({ name: "rejects missing auth", ok: missingAuth.status === 401 });

    const badLimit = await invoke({
      method: "GET",
      path: "?limit=200",
      headers: authHeadersA,
    });
    checks.push({ name: "rejects invalid limit", ok: badLimit.status === 400 });

    const invalidJson = await invoke({
      method: "POST",
      headers: authHeadersA,
      body: "{",
    });
    checks.push({ name: "rejects invalid JSON", ok: invalidJson.status === 400 });

    const created = await invoke({
      method: "POST",
      headers: authHeadersA,
      body: { body: "buy milk", done: false },
    });
    const createdRow = rowFrom(parseJson(created));
    checks.push({
      name: "creates todo for authenticated user",
      ok:
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
      ok:
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
    checks.push({ name: "rejects invalid UUID", ok: invalidUuid.status === 400 });

    const patchOtherUser = await invoke({
      method: "PATCH",
      path: `/${createdRow?.id}`,
      headers: authHeadersB,
      body: { body: "stolen" },
    });
    checks.push({
      name: "returns 404 when patching another user's todo",
      ok: patchOtherUser.status === 404,
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
      ok: ownPatch.status === 200 && ownPatchRow?.id === createdRow?.id && ownPatchRow?.done === true,
    });

    const deleteOtherUser = await invoke({
      method: "DELETE",
      path: `/${createdRow?.id}`,
      headers: authHeadersB,
    });
    checks.push({
      name: "returns 404 when deleting another user's todo",
      ok: deleteOtherUser.status === 404,
    });

    const ownDelete = await invoke({
      method: "DELETE",
      path: `/${createdRow?.id}`,
      headers: authHeadersA,
    });
    checks.push({
      name: "deletes own todo",
      ok: ownDelete.status === 200 && parseJson(ownDelete)?.deleted === true,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      score: checks.filter((c) => c.ok).length / 10,
      notes: [
        ...checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`),
        `FAIL scorer could not evaluate ${FUNCTION_NAME}: ${msg}`,
      ].join("\n"),
    };
  }

  return {
    passed: checks.every((c) => c.ok),
    score: checks.filter((c) => c.ok).length / checks.length,
    notes: checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`).join("\n"),
  };
};

export default scorer;
