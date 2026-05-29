import {
  check,
  type CheckResult,
  type ToolScorer,
} from "@supabase-evals/core";

const PASSWORD = "secret123";

const scorer: ToolScorer = async (ctx) => {
  const clientA = ctx.client;
  const clientB = ctx.getClient();
  const checks: CheckResult[] = [];
  const q = ctx.query;

  try {
    const { data: authA, error: authAError } = await clientA.auth.signUp({
      email: `rls-leak-a-${Date.now()}@example.com`,
      password: PASSWORD,
    });
    const { data: authB, error: authBError } = await clientB.auth.signUp({
      email: `rls-leak-b-${Date.now()}@example.com`,
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
INSERT INTO notes (user_id, body, is_pinned) VALUES
  ('${userAId}', 'a private note', false),
  ('${userBId}', 'b private note', false);
    `);

    const { rows: rls } = await q(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'notes';`
    );
    checks.push(check("RLS still enabled on notes", rls[0]?.relrowsecurity === true));

    const { data: aNotes, error: aNotesError } = await clientA
      .from("notes")
      .select("body,user_id")
      .order("body");
    checks.push({
      type: "deterministic",
      name: "user A reads only own note",
      passed:
        !aNotesError &&
        aNotes?.length === 1 &&
        aNotes[0]?.body === "a private note" &&
        aNotes[0]?.user_id === userAId,
    });

    const { data: bReadsA, error: bReadsAError } = await clientB
      .from("notes")
      .select("id")
      .eq("body", "a private note");
    checks.push({
      type: "deterministic",
      name: "user B cannot read user A note",
      passed: !bReadsAError && Array.isArray(bReadsA) && bReadsA.length === 0,
    });

    const { data: ownUpdate, error: ownUpdateError } = await clientA
      .from("notes")
      .update({ body: "a updated note" })
      .eq("body", "a private note")
      .select("body,user_id");
    checks.push({
      type: "deterministic",
      name: "user A can still update own note",
      passed:
        !ownUpdateError &&
        ownUpdate?.length === 1 &&
        ownUpdate[0]?.body === "a updated note" &&
        ownUpdate[0]?.user_id === userAId,
    });

    await silenceExpectedError(() =>
      clientB
        .from("notes")
        .update({ user_id: userAId, body: "stolen by reassignment" })
        .eq("body", "b private note")
        .select("id,user_id")
    );
    const { rows: reassignedRows } = await q(`
SELECT user_id, body
FROM notes
WHERE body IN ('b private note', 'stolen by reassignment')
ORDER BY body;
    `);
    checks.push({
      type: "deterministic",
      name: "WITH CHECK prevents user_id reassignment",
      passed:
        reassignedRows.length === 1 &&
        reassignedRows[0]?.body === "b private note" &&
        reassignedRows[0]?.user_id === userBId,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      type: "deterministic",
      name: "scorer evaluated RLS fix",
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

async function silenceExpectedError<T>(fn: () => PromiseLike<T>): Promise<T> {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}
