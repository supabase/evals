import type { CheckResult, ToolScorer } from "@supabase-evals/core";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ORG_B = "22222222-2222-2222-2222-222222222222";

// Run SQL inside a transaction with `authenticated` role + JWT sub set,
// so RLS evaluates as that user. Same pattern Supabase uses internally.
const asUser = (sub: string, body: string, finish: "COMMIT" | "ROLLBACK" = "COMMIT") => `
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '${sub}';
SET LOCAL request.jwt.claim.role = 'authenticated';
${body}
${finish};
`;

const scorer: ToolScorer = async (ctx) => {
  const q = (sql: string) =>
    ctx.query(sql);
  const resetTx = async () => {
    try {
      await q("ROLLBACK;");
    } catch {
      // Ignore cleanup errors; this is only to clear an aborted transaction.
    }
  };

  const { rows: rls } = await q(
    `SELECT relrowsecurity FROM pg_class WHERE relname = 'notes';`
  );
  if (!rls[0]?.relrowsecurity) {
    return {
      passed: false,
      checks: [{ type: "deterministic", name: "RLS enabled on notes", passed: false }],
    };
  }

  const checks: CheckResult[] = [];
  try {
    const { rows: aReads } = await q(asUser(USER_A, `SELECT count(*)::int AS n FROM notes;`));
    checks.push({ type: "deterministic", name: "tenant A sees only org A notes (n=2)", passed: aReads[0]?.n === 2 });

    const { rows: bCross } = await q(
      asUser(USER_B, `SELECT count(*)::int AS n FROM notes WHERE org_id = '${ORG_A}';`)
    );
    checks.push({ type: "deterministic", name: "tenant B blocked from org A reads", passed: bCross[0]?.n === 0 });

    let insertBlocked = false;
    try {
      await q(asUser(USER_B, `
        INSERT INTO notes (org_id, author_id, body)
        VALUES ('${ORG_A}', '${USER_B}', 'sneaky');
      `));
    } catch {
      insertBlocked = true;
      await resetTx();
    }
    checks.push({ type: "deterministic", name: "insert into non-member org blocked", passed: insertBlocked });

    const { rows: ownUpdate } = await q(
      asUser(
        USER_A,
        `
        UPDATE notes
        SET body = 'org A note 1 updated'
        WHERE org_id = '${ORG_A}' AND author_id = '${USER_A}' AND body = 'org A note 1'
        RETURNING id;
        `,
        "ROLLBACK"
      )
    );
    checks.push({ type: "deterministic", name: "author can update own note", passed: ownUpdate.length === 1 });

    const { rows: crossUpdate } = await q(
      asUser(
        USER_B,
        `
        UPDATE notes
        SET body = 'cross-tenant update'
        WHERE org_id = '${ORG_A}' AND body = 'org A note 2'
        RETURNING id;
        `,
        "ROLLBACK"
      )
    );
    checks.push({ type: "deterministic", name: "non-member cannot update org A note", passed: crossUpdate.length === 0 });

    const { rows: ownDelete } = await q(
      asUser(
        USER_B,
        `
        DELETE FROM notes
        WHERE org_id = '${ORG_B}' AND author_id = '${USER_B}' AND body = 'org B note 1'
        RETURNING id;
        `,
        "ROLLBACK"
      )
    );
    checks.push({ type: "deterministic", name: "author can delete own note", passed: ownDelete.length === 1 });

    const { rows: crossDelete } = await q(
      asUser(
        USER_B,
        `
        DELETE FROM notes
        WHERE org_id = '${ORG_A}' AND body = 'org A note 2'
        RETURNING id;
        `,
        "ROLLBACK"
      )
    );
    checks.push({ type: "deterministic", name: "non-member cannot delete org A note", passed: crossDelete.length === 0 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      type: "deterministic",
      name: "scorer evaluated policy behavior",
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
