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
      await checkCanSeeOwnOrgMembershipRoster(ctx),
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

type UserQueryResult = { rows: Record<string, unknown>[]; error: Error | null };

/**
 * Runs a query as a given user, via the request.jwt.claim.sub/role
 * technique shown in RLS testing guide:
 * (https://supabase.com/docs/guides/local-development/testing/overview).
 *
 * Other scorers impersonate over PostgREST. This one needs a transaction per
 * check and lite doesn't support Prefer: tx=rollback, so it stays in SQL.
 * (https://github.com/supabase/lite/blob/eb02d45e98840e4639ac23f1e36fe50f36c98077/FEATURES.md#L79)
 *
 * Returns errors (incl. RLS-blocked writes) as values instead of throwing.
 */
async function runAsUser(
  ctx: ToolEvalContext,
  sub: string,
  body: string
): Promise<UserQueryResult> {
  try {
    const { rows } = await ctx.query(stripIndent`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${sub}';
      SET LOCAL request.jwt.claim.role = 'authenticated';
      -- auth.uid() reads claim.sub, auth.jwt() reads the claims JSON. Set both.
      SET LOCAL request.jwt.claims = '{"sub":"${sub}","role":"authenticated"}';
      ${body}
      ROLLBACK;
    `);
    return { rows, error: null };
  } catch (error) {
    await ctx.query('ROLLBACK;').catch(() => {});
    return {
      rows: [],
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * A denied write raises 42501 (insufficient_privilege), or for UPDATE and
 * DELETE quietly matches no rows.
 */
function isDeniedOrEmpty(result: UserQueryResult): boolean {
  const { error, rows } = result;
  if (!error) return rows.length === 0;
  return 'code' in error && error.code === '42501';
}

async function checkRlsEnabled(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(
    `SELECT relrowsecurity FROM pg_class WHERE relname = 'documents';`
  );
  return {
    name: 'RLS enabled on documents',
    passed: rows[0]?.relrowsecurity === true,
  };
}

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

async function checkViewerCannotInsert(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    VIEWER_A,
    stripIndent`
      INSERT INTO documents (org_id, owner_id, title, body)
      VALUES ('${ORG_A}', '${VIEWER_A}', 'viewer insert', 'should fail')
      RETURNING id;
    `
  );
  return { name: 'viewer cannot insert', passed: isDeniedOrEmpty(result) };
}

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
    `
  );
  return {
    name: 'editor can insert own org document',
    passed: !result.error && result.rows.length === 1,
  };
}

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
    `
  );
  return {
    name: 'editor can update own document',
    passed: !result.error && result.rows.length === 1,
  };
}

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
    `
  );
  return {
    name: "editor cannot update another user's document",
    passed: isDeniedOrEmpty(result),
  };
}

async function checkEditorCannotDeleteAnotherUsersDocument(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    EDITOR_A,
    `DELETE FROM documents WHERE id = '10000000-0000-0000-0000-000000000001' RETURNING id;`
  );
  return {
    name: "editor cannot delete another user's document",
    passed: isDeniedOrEmpty(result),
  };
}

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
    `
  );
  return {
    name: 'admin can update any document in their org',
    passed: !result.error && result.rows.length === 1,
  };
}

async function checkAdminCanDeleteAnyDocumentInOrg(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    ADMIN_A,
    `DELETE FROM documents WHERE id = '10000000-0000-0000-0000-000000000002' RETURNING id;`
  );
  return {
    name: 'admin can delete any document in their org',
    passed: !result.error && result.rows.length === 1,
  };
}

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
    `
  );
  return {
    name: 'admin cannot affect another org',
    passed: isDeniedOrEmpty(result),
  };
}

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
    `
  );
  return {
    name: 'WITH CHECK blocks editor from moving document to another org',
    passed: isDeniedOrEmpty(result),
  };
}

/**
 * Without this, an agent that enables RLS on memberships and writes no policies
 * scores the same as one that scoped the roster per org.
 */
async function checkCanSeeOwnOrgMembershipRoster(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const result = await runAsUser(
    ctx,
    EDITOR_A,
    `SELECT user_id FROM memberships WHERE org_id = '${ORG_A}';`
  );
  return {
    name: "editor can still see their own org's roster",
    passed: !result.error && result.rows.length === 4,
  };
}

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
    passed: isDeniedOrEmpty(result),
  };
}

/**
 * Checks that a user's admin role in org B doesn't leak into org A, where
 * they're only a viewer. In the memberships table, role is a column on the
 * (user_id, org_id) row, not the user, so the same user can hold a
 * different role per org. This checks if policies actually join on
 * org_id instead of just checking the user's role anywhere.
 */
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
    `
  );
  return {
    name: "a viewer role in one org doesn't grant admin power in another org",
    passed: isDeniedOrEmpty(result),
  };
}

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
    `
  );
  return {
    name: 'multi-org user can act as admin in the org where they hold that role',
    passed: !result.error && result.rows.length === 1,
  };
}
