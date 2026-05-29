import {
  check,
  type CheckResult,
  type ToolScorer,
} from "@supabase-evals/core";

const USER_A_EMAIL = "todo-user-a@example.com";
const USER_B_EMAIL = "todo-user-b@example.com";
const PASSWORD = "secret123";

const scorer: ToolScorer = async (ctx) => {
  const clientA = ctx.client;
  const clientB = ctx.getClient();
  const checks: CheckResult[] = [];
  const q = ctx.query;

  try {
    const { data: authA, error: authAError } = await clientA.auth.signUp({
      email: USER_A_EMAIL,
      password: PASSWORD,
    });
    const { data: authB, error: authBError } = await clientB.auth.signUp({
      email: USER_B_EMAIL,
      password: PASSWORD,
    });

    if (
      authAError ||
      authBError ||
      !authA.user?.id ||
      !authA.session ||
      !authB.user?.id ||
      !authB.session
    ) {
      return {
        passed: false,
        checks: [
          {
            type: "deterministic",
            name: "created auth sessions",
            passed: false,
            notes: authAError?.message ?? authBError?.message ?? "missing session",
          },
        ],
      };
    }
    const userAId = authA.user.id;
    const userBId = authB.user.id;

    await q(`
INSERT INTO todos (user_id, body, done) VALUES
  ('${userAId}', 'a private todo', false),
  ('${userAId}', 'a done todo', true),
  ('${userBId}', 'b private todo', false);
    `);

    const { rows: rls } = await q(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'todos';`
    );
    checks.push(check("RLS enabled on todos", rls[0]?.relrowsecurity === true));

    const { data: aTodos, error: aTodosError } = await clientA
      .from("todos")
      .select("body,user_id")
      .order("body");
    checks.push({
      type: "deterministic",
      name: "user A sees only own todos",
      passed:
        !aTodosError &&
        aTodos?.length === 2 &&
        aTodos.every((todo) => todo.user_id === userAId) &&
        aTodos.map((todo) => todo.body).join(",") === "a done todo,a private todo",
    });

    const { data: bReadsA, error: bReadsAError } = await clientB
      .from("todos")
      .select("id")
      .eq("body", "a private todo");
    checks.push({
      type: "deterministic",
      name: "user B cannot read user A todos",
      passed: !bReadsAError && Array.isArray(bReadsA) && bReadsA.length === 0,
    });

    const { data: ownInsert, error: ownInsertError } = await clientA
      .from("todos")
      .insert({ body: "a client insert" })
      .select("body,user_id")
      .single();
    checks.push({
      type: "deterministic",
      name: "user A can insert own todo through supabase-js",
      passed:
        !ownInsertError &&
        ownInsert?.body === "a client insert" &&
        ownInsert.user_id === userAId,
    });

    const { data: spoofInsert, error: spoofInsertError } = await silenceExpectedError(() =>
      clientB
        .from("todos")
        .insert({ user_id: userAId, body: "b spoofed as a" })
        .select("id")
    );
    checks.push({
      type: "deterministic",
      name: "user B cannot insert todo for user A",
      passed: Boolean(spoofInsertError) || !spoofInsert || spoofInsert.length === 0,
    });

    const { data: ownUpdate, error: ownUpdateError } = await clientA
      .from("todos")
      .update({ done: true })
      .eq("body", "a private todo")
      .select("body,done");
    checks.push({
      type: "deterministic",
      name: "user A can update own todo",
      passed: !ownUpdateError && ownUpdate?.length === 1 && ownUpdate[0]?.done === true,
    });

    const { data: crossUpdate, error: crossUpdateError } = await clientB
      .from("todos")
      .update({ body: "b changed a todo" })
      .eq("body", "a done todo")
      .select("id");
    checks.push({
      type: "deterministic",
      name: "user B cannot update user A todo",
      passed: Boolean(crossUpdateError) || !crossUpdate || crossUpdate.length === 0,
    });

    const { data: ownDelete, error: ownDeleteError } = await clientB
      .from("todos")
      .delete()
      .eq("body", "b private todo")
      .select("id");
    checks.push({
      type: "deterministic",
      name: "user B can delete own todo",
      passed: !ownDeleteError && ownDelete?.length === 1,
    });

    const { data: crossDelete, error: crossDeleteError } = await clientB
      .from("todos")
      .delete()
      .eq("body", "a done todo")
      .select("id");
    checks.push({
      type: "deterministic",
      name: "user B cannot delete user A todo",
      passed: Boolean(crossDeleteError) || !crossDelete || crossDelete.length === 0,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
        checks.push({
      type: "deterministic",
      name: "scorer evaluated client RLS behavior",
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

async function silenceExpectedError<T>(fn: () => PromiseLike<T>): Promise<T> {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}
