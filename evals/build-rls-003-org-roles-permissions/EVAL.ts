import type { CheckResult, ToolScorer } from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const ADMIN_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EDITOR_A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const VIEWER_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const asUser = (
  sub: string,
  body: string,
  finish: 'COMMIT' | 'ROLLBACK' = 'COMMIT'
) => stripIndent`
  BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claim.sub = '${sub}';
  SET LOCAL request.jwt.claim.role = 'authenticated';
  ${body}
  ${finish};
`;

const scorer: ToolScorer = async (ctx) => {
  const q = (sql: string) => ctx.query(sql);
  const checks: CheckResult[] = [];

  const resetTx = async () => {
    try {
      await q('ROLLBACK;');
    } catch {
      // Clear aborted scorer transactions.
    }
  };

  try {
    const { rows: rls } = await q(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'documents';`
    );
    checks.push({
      name: 'RLS enabled on documents',
      passed: rls[0]?.relrowsecurity === true,
    });

    const { rows: viewerReads } = await q(
      asUser(VIEWER_A, `SELECT title FROM documents ORDER BY title;`)
    );
    checks.push({
      name: 'viewer sees only documents in their org',
      passed:
        viewerReads.length === 2 &&
        viewerReads.map((row) => row.title).join(',') ===
          'Admin plan,Editor draft',
    });

    let viewerInsertBlocked = false;
    try {
      await q(
        asUser(
          VIEWER_A,
          stripIndent`
            INSERT INTO documents (org_id, owner_id, title, body)
            VALUES ('${ORG_A}', '${VIEWER_A}', 'viewer insert', 'should fail');
          `
        )
      );
    } catch {
      viewerInsertBlocked = true;
      await resetTx();
    }
    checks.push({ name: 'viewer cannot insert', passed: viewerInsertBlocked });

    const { rows: editorInsert } = await q(
      asUser(
        EDITOR_A,
        stripIndent`
          INSERT INTO documents (org_id, owner_id, title, body)
          VALUES ('${ORG_A}', '${EDITOR_A}', 'editor insert', 'allowed')
          RETURNING id;
        `,
        'ROLLBACK'
      )
    );
    checks.push({
      name: 'editor can insert own org document',
      passed: editorInsert.length === 1,
    });

    const { rows: editorOwnUpdate } = await q(
      asUser(
        EDITOR_A,
        stripIndent`
          UPDATE documents
          SET body = 'editor changed own document'
          WHERE id = '10000000-0000-0000-0000-000000000002'
          RETURNING id;
        `,
        'ROLLBACK'
      )
    );
    checks.push({
      name: 'editor can update own document',
      passed: editorOwnUpdate.length === 1,
    });

    const { rows: editorUpdatesAdmin } = await q(
      asUser(
        EDITOR_A,
        stripIndent`
          UPDATE documents
          SET body = 'editor changed admin document'
          WHERE id = '10000000-0000-0000-0000-000000000001'
          RETURNING id;
        `,
        'ROLLBACK'
      )
    );
    checks.push({
      name: "editor cannot update another user's document",
      passed: editorUpdatesAdmin.length === 0,
    });

    let editorDeleteBlocked = false;
    try {
      const { rows } = await q(
        asUser(
          EDITOR_A,
          `DELETE FROM documents WHERE id = '10000000-0000-0000-0000-000000000001' RETURNING id;`,
          'ROLLBACK'
        )
      );
      editorDeleteBlocked = rows.length === 0;
    } catch {
      editorDeleteBlocked = true;
      await resetTx();
    }
    checks.push({
      name: "editor cannot delete another user's document",
      passed: editorDeleteBlocked,
    });

    const { rows: adminUpdate } = await q(
      asUser(
        ADMIN_A,
        stripIndent`
          UPDATE documents
          SET body = 'admin changed editor document'
          WHERE id = '10000000-0000-0000-0000-000000000002'
          RETURNING id;
        `,
        'ROLLBACK'
      )
    );
    checks.push({
      name: 'admin can update any document in their org',
      passed: adminUpdate.length === 1,
    });

    const { rows: adminDelete } = await q(
      asUser(
        ADMIN_A,
        `DELETE FROM documents WHERE id = '10000000-0000-0000-0000-000000000002' RETURNING id;`,
        'ROLLBACK'
      )
    );
    checks.push({
      name: 'admin can delete any document in their org',
      passed: adminDelete.length === 1,
    });

    const { rows: adminCrossOrg } = await q(
      asUser(
        ADMIN_A,
        stripIndent`
          UPDATE documents
          SET body = 'admin touched another org'
          WHERE id = '20000000-0000-0000-0000-000000000001'
          RETURNING id;
        `,
        'ROLLBACK'
      )
    );
    checks.push({
      name: 'admin cannot affect another org',
      passed: adminCrossOrg.length === 0,
    });

    let orgReassignmentBlocked = false;
    try {
      const { rows } = await q(
        asUser(
          EDITOR_A,
          stripIndent`
            UPDATE documents
            SET org_id = '${ORG_B}'
            WHERE id = '10000000-0000-0000-0000-000000000002'
            RETURNING id;
          `,
          'ROLLBACK'
        )
      );
      orgReassignmentBlocked = rows.length === 0;
    } catch {
      orgReassignmentBlocked = true;
      await resetTx();
    }
    checks.push({
      name: 'WITH CHECK blocks editor from moving document to another org',
      passed: orgReassignmentBlocked,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      name: 'scorer evaluated org role RLS',
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
