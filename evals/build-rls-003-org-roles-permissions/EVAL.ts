import type {
  CheckResult,
  ToolEvalContext,
  ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const ADMIN_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EDITOR_A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const VIEWER_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const MULTI_ORG_USER = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkRlsEnabled(ctx),
      await checkViewerSeesOnlyOwnOrgDocuments(ctx),
      await checkViewerCannotInsert(ctx),
      await checkEditorCanInsertOwnOrgDocument(ctx),
      await checkEditorCanUpdateOwnDocument(ctx),
      await checkEditorCannotUpdateAnotherUsersDocument(ctx),
      await checkEditorCannotDeleteAnotherUsersDocument(ctx),
      await checkAdminCanUpdateAnyDocumentInOrg(ctx),
      await checkAdminCanDeleteAnyDocumentInOrg(ctx),
      await checkAdminCannotAffectAnotherOrg(ctx),
      await checkWithCheckBlocksOrgReassignment(ctx),
      await checkCannotSeeAnotherOrgsMembershipRoster(ctx),
      await checkOtherOrgRoleDoesNotLeakIn(ctx),
      await checkOwnOrgAdminRoleStillWorks(ctx),
    ];
    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated org role RLS', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

/** Builds the SQL to run a query as a given user via forged JWT claims, the same session state PostgREST sets for a real request. */
function asUser(
  sub: string,
  body: string,
  finish: 'COMMIT' | 'ROLLBACK' = 'COMMIT'
): string {
  return stripIndent`
    BEGIN;
    SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub = '${sub}';
    SET LOCAL request.jwt.claim.role = 'authenticated';
    ${body}
    ${finish};
  `;
}

type UserQueryResult = { rows: Record<string, unknown>[]; error: Error | null };

/** Runs a query as a user without throwing, so RLS-blocked writes (WITH CHECK violations, revoked grants) are a value each check can judge, not an exception that aborts every check after it. */
async function runAsUser(
  ctx: ToolEvalContext,
  sub: string,
  body: string,
  finish: 'COMMIT' | 'ROLLBACK' = 'COMMIT'
): Promise<UserQueryResult> {
  try {
    const { rows } = await ctx.query(asUser(sub, body, finish));
    return { rows, error: null };
  } catch (error) {
    await ctx.query('ROLLBACK;').catch(() => {});
    return {
      rows: [],
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/** Checks that RLS is turned on for the documents table at all. */
async function checkRlsEnabled(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(
    `SELECT relrowsecurity FROM pg_class WHERE relname = 'documents';`
  );
  return {
    name: 'RLS enabled on documents',
    passed: rows[0]?.relrowsecurity === true,
  };
}

/** Checks that a viewer only sees active documents in their own org. */
async function checkViewerSeesOnlyOwnOrgDocuments(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    VIEWER_A,
    `SELECT title FROM documents ORDER BY title;`
  );
  return {
    name: 'viewer sees only documents in their org',
    passed:
      !result.error &&
      result.rows.length === 2 &&
      result.rows.map((row) => row.title).join(',') ===
        'Admin plan,Editor draft',
  };
}

/** Checks that a viewer cannot insert a new document. */
async function checkViewerCannotInsert(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    VIEWER_A,
    stripIndent`
      INSERT INTO documents (org_id, owner_id, title, body)
      VALUES ('${ORG_A}', '${VIEWER_A}', 'viewer insert', 'should fail');
    `
  );
  return { name: 'viewer cannot insert', passed: Boolean(result.error) };
}

/** Checks that an editor can insert a document they own in their org. */
async function checkEditorCanInsertOwnOrgDocument(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    EDITOR_A,
    stripIndent`
      INSERT INTO documents (org_id, owner_id, title, body)
      VALUES ('${ORG_A}', '${EDITOR_A}', 'editor insert', 'allowed')
      RETURNING id;
    `,
    'ROLLBACK'
  );
  return {
    name: 'editor can insert own org document',
    passed: !result.error && result.rows.length === 1,
  };
}

/** Checks that an editor can update a document they own. */
async function checkEditorCanUpdateOwnDocument(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    EDITOR_A,
    stripIndent`
      UPDATE documents
      SET body = 'editor changed own document'
      WHERE id = '10000000-0000-0000-0000-000000000002'
      RETURNING id;
    `,
    'ROLLBACK'
  );
  return {
    name: 'editor can update own document',
    passed: !result.error && result.rows.length === 1,
  };
}

/** Checks that an editor cannot update a document owned by someone else. */
async function checkEditorCannotUpdateAnotherUsersDocument(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    EDITOR_A,
    stripIndent`
      UPDATE documents
      SET body = 'editor changed admin document'
      WHERE id = '10000000-0000-0000-0000-000000000001'
      RETURNING id;
    `,
    'ROLLBACK'
  );
  return {
    name: "editor cannot update another user's document",
    passed: Boolean(result.error) || result.rows.length === 0,
  };
}

/** Checks that an editor cannot delete a document owned by someone else. */
async function checkEditorCannotDeleteAnotherUsersDocument(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    EDITOR_A,
    `DELETE FROM documents WHERE id = '10000000-0000-0000-0000-000000000001' RETURNING id;`,
    'ROLLBACK'
  );
  return {
    name: "editor cannot delete another user's document",
    passed: Boolean(result.error) || result.rows.length === 0,
  };
}

/** Checks that an admin can update any document in their org, not just their own. */
async function checkAdminCanUpdateAnyDocumentInOrg(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    ADMIN_A,
    stripIndent`
      UPDATE documents
      SET body = 'admin changed editor document'
      WHERE id = '10000000-0000-0000-0000-000000000002'
      RETURNING id;
    `,
    'ROLLBACK'
  );
  return {
    name: 'admin can update any document in their org',
    passed: !result.error && result.rows.length === 1,
  };
}

/** Checks that an admin can delete any document in their org, not just their own. */
async function checkAdminCanDeleteAnyDocumentInOrg(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    ADMIN_A,
    `DELETE FROM documents WHERE id = '10000000-0000-0000-0000-000000000002' RETURNING id;`,
    'ROLLBACK'
  );
  return {
    name: 'admin can delete any document in their org',
    passed: !result.error && result.rows.length === 1,
  };
}

/** Checks that an admin cannot affect documents in a different org. */
async function checkAdminCannotAffectAnotherOrg(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    ADMIN_A,
    stripIndent`
      UPDATE documents
      SET body = 'admin touched another org'
      WHERE id = '20000000-0000-0000-0000-000000000001'
      RETURNING id;
    `,
    'ROLLBACK'
  );
  return {
    name: 'admin cannot affect another org',
    passed: Boolean(result.error) || result.rows.length === 0,
  };
}

/** Checks that WITH CHECK blocks an editor from moving a document to another org. */
async function checkWithCheckBlocksOrgReassignment(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    EDITOR_A,
    stripIndent`
      UPDATE documents
      SET org_id = '${ORG_B}'
      WHERE id = '10000000-0000-0000-0000-000000000002'
      RETURNING id;
    `,
    'ROLLBACK'
  );
  return {
    name: 'WITH CHECK blocks editor from moving document to another org',
    passed: Boolean(result.error) || result.rows.length === 0,
  };
}

/** Checks that a member of one org cannot see another org's membership roster. */
async function checkCannotSeeAnotherOrgsMembershipRoster(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    EDITOR_A,
    `SELECT user_id FROM memberships WHERE org_id = '${ORG_B}';`
  );
  return {
    name: "cannot see another org's membership roster",
    passed: Boolean(result.error) || result.rows.length === 0,
  };
}

/** Checks that a user who is admin in org B can't use that role to write in org A, where they're only a viewer. Role lives on the (user_id, org_id) row, not the user, so this only holds if the org_id join was actually applied. */
async function checkOtherOrgRoleDoesNotLeakIn(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    MULTI_ORG_USER,
    stripIndent`
      UPDATE documents
      SET body = 'multi-org user tried to act as admin here'
      WHERE id = '10000000-0000-0000-0000-000000000001'
      RETURNING id;
    `,
    'ROLLBACK'
  );
  return {
    name: "a viewer role in one org doesn't grant admin power in another org",
    passed: Boolean(result.error) || result.rows.length === 0,
  };
}

/** Checks that the same multi-org user's admin role still works normally in the org where they actually hold it. */
async function checkOwnOrgAdminRoleStillWorks(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    MULTI_ORG_USER,
    stripIndent`
      UPDATE documents
      SET body = 'multi-org user acting as admin in their own org'
      WHERE id = '20000000-0000-0000-0000-000000000001'
      RETURNING id;
    `,
    'ROLLBACK'
  );
  return {
    name: 'multi-org user can act as admin in the org where they hold that role',
    passed: !result.error && result.rows.length === 1,
  };
}
