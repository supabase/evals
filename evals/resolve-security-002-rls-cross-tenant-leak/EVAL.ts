import { randomUUID } from "node:crypto";
import type { CheckResult, ToolScorer } from "@supabase-evals/core";

const PASSWORD = "secret123";
const USER_A_EMAIL = "tenant-notes-a@example.com";
const USER_B_EMAIL = "tenant-notes-b@example.com";

const scorer: ToolScorer = async (ctx) => {
  const clientA = ctx.client;
  const clientB = ctx.getClient();
  const q = ctx.query;

  try {
    const orgAId = randomUUID();
    const orgBId = randomUUID();
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
INSERT INTO memberships (user_id, org_id) VALUES
  ('${userAId}', '${orgAId}'),
  ('${userBId}', '${orgBId}');

INSERT INTO notes (org_id, author_id, body) VALUES
  ('${orgAId}', '${userAId}', 'org A note 1'),
  ('${orgAId}', '${userAId}', 'org A note 2'),
  ('${orgBId}', '${userBId}', 'org B note 1');
    `);

    const { rows: rls } = await q(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'notes';`
    );
    const rlsEnabled = rls[0]?.relrowsecurity === true;

    const aNotes = await clientA
      .from("notes")
      .select("body,org_id,author_id")
      .order("body");

    const bReadsA = await clientB
      .from("notes")
      .select("id")
      .eq("org_id", orgAId);

    const ownUpdate = await clientA
      .from("notes")
      .update({ body: "org A note 1 updated" })
      .eq("body", "org A note 1")
      .select("body,author_id");

    const crossUpdate = await clientB
      .from("notes")
      .update({ body: "cross-tenant update" })
      .eq("body", "org A note 2")
      .select("id");

    const ownDelete = await clientB
      .from("notes")
      .delete()
      .eq("body", "org B note 1")
      .select("id");

    const crossDelete = await clientB
      .from("notes")
      .delete()
      .eq("body", "org A note 2")
      .select("id");

    const checks: CheckResult[] = [
      { name: "RLS enabled on notes", passed: rlsEnabled },
      {
        name: "tenant A sees only org A notes",
        passed:
          !aNotes.error &&
          aNotes.data?.length === 2 &&
          aNotes.data.every((note) => note.org_id === orgAId && note.author_id === userAId) &&
          aNotes.data.map((note) => note.body).join(",") === "org A note 1,org A note 2",
      },
      {
        name: "tenant B cannot read org A notes",
        passed: !bReadsA.error && Array.isArray(bReadsA.data) && bReadsA.data.length === 0,
      },
      {
        name: "tenant A author can update own note",
        passed:
          !ownUpdate.error &&
          ownUpdate.data?.length === 1 &&
          ownUpdate.data[0]?.body === "org A note 1 updated" &&
          ownUpdate.data[0]?.author_id === userAId,
      },
      {
        name: "tenant B cannot update org A note",
        passed: Boolean(crossUpdate.error) || !crossUpdate.data || crossUpdate.data.length === 0,
      },
      {
        name: "tenant B author can delete own note",
        passed: !ownDelete.error && ownDelete.data?.length === 1,
      },
      {
        name: "tenant B cannot delete org A note",
        passed: Boolean(crossDelete.error) || !crossDelete.data || crossDelete.data.length === 0,
      },
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: "scorer evaluated client RLS behavior", passed: false, notes: msg }],
    };
  }
};

export default scorer;
