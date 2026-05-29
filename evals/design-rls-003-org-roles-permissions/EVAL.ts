import {
  check,
  type CheckResult,
  type ToolScorer,
} from "@supabase-evals/core";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const ADMIN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const EDITOR_A = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const VIEWER_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";

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
  const checks: CheckResult[] = [];

  const resetTx = async () => {
    try {
      await q("ROLLBACK;");
    } catch {
      // Clear aborted scorer transactions.
    }
  };

  try {
    const { rows: rls } = await q(
      `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('documents', 'document_audit');`
    );
    checks.push({
      type: "deterministic",
      name: "RLS enabled on documents",
      passed: rls.some((row) => row.relname === "documents" && row.relrowsecurity === true),
    });

    const { rows: viewerReads } = await q(
      asUser(
        VIEWER_A,
        `SELECT title FROM documents ORDER BY title;`
      )
    );
    checks.push({
      type: "deterministic",
      name: "viewer sees active org documents only",
      passed:
        viewerReads.length === 2 &&
        viewerReads.map((row) => row.title).join(",") === "Admin plan,Editor draft",
    });

    let viewerInsertBlocked = false;
    try {
      await q(
        asUser(
          VIEWER_A,
          `
INSERT INTO documents (org_id, owner_id, title, body)
VALUES ('${ORG_A}', '${VIEWER_A}', 'viewer insert', 'should fail');
          `
        )
      );
    } catch {
      viewerInsertBlocked = true;
      await resetTx();
    }
    checks.push(check("viewer cannot insert", viewerInsertBlocked));

    const { rows: editorInsert } = await q(
      asUser(
        EDITOR_A,
        `
INSERT INTO documents (org_id, owner_id, title, body)
VALUES ('${ORG_A}', '${EDITOR_A}', 'editor insert', 'allowed')
RETURNING id;
        `,
        "ROLLBACK"
      )
    );
    checks.push(check("editor can insert own org document", editorInsert.length === 1));

    const { rows: editorOwnUpdate } = await q(
      asUser(
        EDITOR_A,
        `
UPDATE documents
SET body = 'editor changed own document'
WHERE id = '10000000-0000-0000-0000-000000000002'
RETURNING id;
        `,
        "ROLLBACK"
      )
    );
    checks.push(check("editor can update own document", editorOwnUpdate.length === 1));

    const { rows: editorUpdatesAdmin } = await q(
      asUser(
        EDITOR_A,
        `
UPDATE documents
SET body = 'editor changed admin document'
WHERE id = '10000000-0000-0000-0000-000000000001'
RETURNING id;
        `,
        "ROLLBACK"
      )
    );
    checks.push({
      type: "deterministic",
      name: "editor cannot update another user's document",
      passed: editorUpdatesAdmin.length === 0,
    });

    await q(
      asUser(
        ADMIN_A,
        `
DELETE FROM documents
WHERE id = '10000000-0000-0000-0000-000000000001';
        `
      )
    );
    const { rows: adminSoftDelete } = await q(
      `SELECT id, deleted_at FROM documents WHERE id = '10000000-0000-0000-0000-000000000001';`
    );
    checks.push({
      type: "deterministic",
      name: "admin delete soft-deletes document in org",
      passed:
        adminSoftDelete.length === 1 &&
        adminSoftDelete[0]?.id === "10000000-0000-0000-0000-000000000001" &&
        Boolean(adminSoftDelete[0]?.deleted_at),
    });

    const { rows: adminCrossOrg } = await q(
      asUser(
        ADMIN_A,
        `
UPDATE documents
SET deleted_at = now()
WHERE id = '20000000-0000-0000-0000-000000000001'
RETURNING id;
        `,
        "ROLLBACK"
      )
    );
    checks.push(check("admin cannot affect another org", adminCrossOrg.length === 0));

    let orgReassignmentBlocked = false;
    try {
      const { rows } = await q(
        asUser(
          EDITOR_A,
          `
UPDATE documents
SET org_id = '${ORG_B}'
WHERE id = '10000000-0000-0000-0000-000000000002'
RETURNING id;
          `,
          "ROLLBACK"
        )
      );
      orgReassignmentBlocked = rows.length === 0;
    } catch {
      orgReassignmentBlocked = true;
      await resetTx();
    }
    checks.push({
      type: "deterministic",
      name: "WITH CHECK blocks editor from moving document to another org",
      passed: orgReassignmentBlocked,
    });

    const { rows: auditedUpdate } = await q(
      asUser(
        EDITOR_A,
        `
UPDATE documents
SET body = 'audit verifier'
WHERE id = '10000000-0000-0000-0000-000000000002'
RETURNING id;
        `
      )
    );
    const { rows: auditRows } = await q(
      `SELECT actor_id, document_id FROM document_audit WHERE document_id = '10000000-0000-0000-0000-000000000002';`
    );
    checks.push({
      type: "deterministic",
      name: "write creates audit row with acting user",
      passed:
        auditedUpdate.length === 1 &&
        auditRows.some(
          (row) =>
            row.actor_id === EDITOR_A &&
            row.document_id === "10000000-0000-0000-0000-000000000002"
        ),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      type: "deterministic",
      name: "scorer evaluated org role RLS",
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
