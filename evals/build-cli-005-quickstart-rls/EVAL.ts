import { randomUUID } from 'node:crypto';
import {
  judge,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
  type SupabaseClient,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const PASSWORD = 'secret123';
const SEEDED_TABLES = [
  'documents',
  'teams',
  'team_members',
  'team_documents',
] as const;

/**
 * Columns the intended policies have to filter on. `team_members.team_id` is
 * absent on purpose: it already leads that table's primary key, so the prompt's
 * indexing rule does not ask for another index on it.
 */
const POLICY_FILTER_COLUMNS = [
  { table: 'documents', column: 'owner_id' },
  { table: 'team_members', column: 'user_id' },
  { table: 'team_documents', column: 'team_id' },
];

/**
 * Schemas the local stack ships with, so any other schema holding the agent's
 * `security definer` helper is one it created for the purpose. Schemas starting
 * with `pg_` or `_` are treated as pre-existing too.
 */
const PRE_EXISTING_SCHEMAS = new Set([
  'public',
  'graphql',
  'graphql_public',
  'auth',
  'storage',
  'realtime',
  'extensions',
  'vault',
  'pgsodium',
  'pgsodium_masks',
  'pgbouncer',
  'pgtle',
  'dbdev',
  'net',
  'cron',
  'pgmq',
  'supabase_functions',
  'supabase_migrations',
  'information_schema',
  'tests',
]);

/** Allow + deny for four operations across two roles is eight assertions. */
const MIN_PGTAP_TESTS = 8;

const scorer: LocalStackScorer = async (ctx) => {
  try {
    // Snapshot the catalog before running the agent's pgTAP suite, so nothing
    // a test leaves behind can change what the schema checks see.
    const tables = await loadTableState(ctx);
    const policies = await loadPolicies(ctx);
    const helpers = await loadPrivateSecurityDefiners(ctx);

    const setup = await setupFixtures(ctx);
    if ('failure' in setup) {
      return { passed: false, checks: [setup.failure] };
    }
    const fixtures = setup.fixtures;

    const checks: CheckResult[] = [
      checkRlsEnabled(tables),
      checkLookupTableNotForced(tables),
      checkPoliciesScopedToRole(policies),
      checkOnePolicyPerOperation(policies),
      checkUpdatePoliciesHaveBothClauses(policies),
      checkAuthCallsWrapped(policies),
      await checkPolicyColumnsIndexed(ctx),
      checkPrivateHelperExists(helpers),
      checkTeamPolicyUsesHelper(policies, helpers),
      ...(await checkGrants(ctx)),
      ...(await checkDocumentVisibility(fixtures)),
      ...(await checkDocumentWrites(ctx, fixtures)),
      ...(await checkTeamDocumentVisibility(fixtures)),
      await checkTestFilesExist(ctx),
      await checkPgTapSuitePasses(ctx),
      await checkTestCoverage(ctx),
    ];

    return {
      passed: checks.every((check) => check.passed),
      checks,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated RLS policies and tests',
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};

export default scorer;

type TableState = {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
};

type PolicyRow = {
  tablename: string;
  policyname: string;
  cmd: string;
  roles: unknown;
  qual: string | null;
  with_check: string | null;
};

type HelperRow = {
  schema_name: string;
  proname: string;
  search_path_pinned: boolean;
};

async function loadTableState(
  ctx: LocalStackEvalContext
): Promise<TableState[]> {
  const { rows } = await ctx.query(stripIndent`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  `);
  return rows as TableState[];
}

async function loadPolicies(ctx: LocalStackEvalContext): Promise<PolicyRow[]> {
  const { rows } = await ctx.query(stripIndent`
    SELECT tablename, policyname, cmd, roles, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
  `);
  return rows as PolicyRow[];
}

/** `security definer` functions the agent put in a schema it created itself. */
async function loadPrivateSecurityDefiners(
  ctx: LocalStackEvalContext
): Promise<HelperRow[]> {
  const { rows } = await ctx.query(stripIndent`
    SELECT
      n.nspname AS schema_name,
      p.proname,
      coalesce(
        (SELECT true FROM unnest(p.proconfig) AS cfg WHERE cfg LIKE 'search_path=%'),
        false
      ) AS search_path_pinned
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef
  `);
  return (rows as HelperRow[]).filter(
    (row) =>
      !PRE_EXISTING_SCHEMAS.has(row.schema_name) &&
      !row.schema_name.startsWith('pg_') &&
      !row.schema_name.startsWith('_')
  );
}

function checkRlsEnabled(tables: TableState[]): CheckResult {
  const missing = SEEDED_TABLES.filter(
    (name) => tables.find((t) => t.relname === name)?.relrowsecurity !== true
  );
  return {
    name: 'row level security is enabled on every seeded table',
    passed: missing.length === 0,
    notes:
      missing.length === 0
        ? undefined
        : `RLS not enabled on: ${missing.join(', ')}`,
  };
}

// The prompt warns that `force row level security` breaks a `security definer`
// helper reading the table as its owner, so forcing it on the membership lookup
// is the specific footgun it calls out.
function checkLookupTableNotForced(tables: TableState[]): CheckResult {
  const forced =
    tables.find((t) => t.relname === 'team_members')?.relforcerowsecurity ===
    true;
  return {
    name: 'row level security is not forced on the team_members lookup table',
    passed: !forced,
    notes: forced
      ? 'team_members has FORCE ROW LEVEL SECURITY, which breaks a security definer helper reading it'
      : undefined,
  };
}

function checkPoliciesScopedToRole(policies: PolicyRow[]): CheckResult {
  const unscoped = policies.filter((policy) => {
    const roles = rolesOf(policy);
    return roles.length === 0 || roles.includes('public');
  });
  return {
    name: 'every policy is scoped to a role instead of defaulting to public',
    passed: policies.length > 0 && unscoped.length === 0,
    notes:
      policies.length === 0
        ? 'no policies found on any public table'
        : unscoped.length === 0
          ? undefined
          : `unscoped: ${unscoped.map((p) => `${p.tablename}.${p.policyname}`).join(', ')}`,
  };
}

function checkOnePolicyPerOperation(policies: PolicyRow[]): CheckResult {
  const documentPolicies = policies.filter((p) => p.tablename === 'documents');
  const commands = new Set(documentPolicies.map((p) => p.cmd.toUpperCase()));
  const missing = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].filter(
    (cmd) => !commands.has(cmd)
  );
  const catchAll = commands.has('ALL');
  return {
    name: 'documents has a separate policy per operation, with no FOR ALL catch-all',
    passed: missing.length === 0 && !catchAll,
    notes:
      missing.length === 0 && !catchAll
        ? undefined
        : [
            missing.length > 0 ? `no policy for: ${missing.join(', ')}` : null,
            catchAll ? 'a FOR ALL policy covers every operation' : null,
          ]
            .filter(Boolean)
            .join('; '),
  };
}

function checkUpdatePoliciesHaveBothClauses(
  policies: PolicyRow[]
): CheckResult {
  const updates = policies.filter((p) => p.cmd.toUpperCase() === 'UPDATE');
  const incomplete = updates.filter((p) => !p.qual || !p.with_check);
  return {
    name: 'every UPDATE policy has both a USING and a WITH CHECK clause',
    passed: updates.length > 0 && incomplete.length === 0,
    notes:
      updates.length === 0
        ? 'no UPDATE policies found'
        : incomplete.length === 0
          ? undefined
          : `missing a clause: ${incomplete.map((p) => `${p.tablename}.${p.policyname}`).join(', ')}`,
  };
}

// Postgres renders a wrapped call as `( SELECT auth.uid() AS uid)` and a bare
// one as `auth.uid()`, so comparing the two counts catches per-row calls
// without depending on how the agent spaced its SQL.
function checkAuthCallsWrapped(policies: PolicyRow[]): CheckResult {
  const offenders = policies.filter((policy) =>
    expressionsOf([policy]).some((expression) => {
      const calls = countMatches(expression, /auth\.(uid|jwt)\s*\(\s*\)/gi);
      const wrapped = countMatches(
        expression,
        /\(\s*SELECT\s+auth\.(uid|jwt)\s*\(\s*\)/gi
      );
      return calls > wrapped;
    })
  );
  return {
    name: 'policies wrap auth.uid()/auth.jwt() in a select instead of calling per row',
    passed: offenders.length === 0,
    notes:
      offenders.length === 0
        ? undefined
        : `unwrapped call in: ${offenders.map((p) => `${p.tablename}.${p.policyname}`).join(', ')}`,
  };
}

async function checkPolicyColumnsIndexed(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT c.relname AS table_name, a.attname AS column_name
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
    WHERE n.nspname = 'public' AND i.indisvalid
  `);
  const indexed = new Set(
    rows.map((row) => `${String(row.table_name)}.${String(row.column_name)}`)
  );
  const missing = POLICY_FILTER_COLUMNS.filter(
    ({ table, column }) => !indexed.has(`${table}.${column}`)
  );
  return {
    name: 'columns the policies filter on are indexed',
    passed: missing.length === 0,
    notes:
      missing.length === 0
        ? undefined
        : `no leading-column index on: ${missing.map((c) => `${c.table}.${c.column}`).join(', ')}`,
  };
}

function checkPrivateHelperExists(helpers: HelperRow[]): CheckResult {
  const pinned = helpers.filter((helper) => helper.search_path_pinned);
  return {
    name: 'a security definer helper lives in a private schema with search_path pinned',
    passed: pinned.length > 0,
    notes:
      pinned.length > 0
        ? `found ${pinned.map((h) => `${h.schema_name}.${h.proname}`).join(', ')}`
        : helpers.length > 0
          ? `found ${helpers.map((h) => `${h.schema_name}.${h.proname}`).join(', ')}, but none set search_path`
          : 'no security definer function outside the stack schemas',
  };
}

function checkTeamPolicyUsesHelper(
  policies: PolicyRow[],
  helpers: HelperRow[]
): CheckResult {
  const expressions = expressionsOf(
    policies.filter((p) => p.tablename === 'team_documents')
  );
  const name =
    'team_documents policies call the helper instead of joining team_members';

  if (expressions.length === 0) {
    return { name, passed: false, notes: 'no policies on team_documents' };
  }

  const joined = expressions.filter((expression) =>
    /\bFROM\s+(public\.)?team_members\b/i.test(expression)
  );
  const callsHelper = helpers.some((helper) =>
    expressions.some((expression) =>
      new RegExp(
        `\\b${helper.schema_name}\\.${helper.proname}\\s*\\(`,
        'i'
      ).test(expression)
    )
  );

  return {
    name,
    passed: callsHelper && joined.length === 0,
    notes:
      callsHelper && joined.length === 0
        ? undefined
        : [
            callsHelper ? null : 'no private helper referenced',
            joined.length > 0
              ? 'policy selects from team_members inline'
              : null,
          ]
            .filter(Boolean)
            .join('; '),
  };
}

async function checkGrants(ctx: LocalStackEvalContext): Promise<CheckResult[]> {
  const { rows } = await ctx.query(stripIndent`
    SELECT
      has_table_privilege('authenticated', 'public.documents', 'SELECT') AS authed_select,
      has_table_privilege('authenticated', 'public.documents', 'INSERT') AS authed_insert,
      has_table_privilege('authenticated', 'public.documents', 'UPDATE') AS authed_update,
      has_table_privilege('authenticated', 'public.documents', 'DELETE') AS authed_delete,
      has_table_privilege('anon', 'public.documents', 'SELECT') AS anon_select,
      has_table_privilege('anon', 'public.documents', 'INSERT') AS anon_insert,
      has_table_privilege('anon', 'public.documents', 'UPDATE') AS anon_update,
      has_table_privilege('anon', 'public.documents', 'DELETE') AS anon_delete,
      has_table_privilege('authenticated', 'public.team_members', 'SELECT') AS authed_members,
      has_table_privilege('anon', 'public.team_members', 'SELECT') AS anon_members
  `);
  const grants = rows[0] ?? {};
  const authedMissing = (
    [
      'authed_select',
      'authed_insert',
      'authed_update',
      'authed_delete',
    ] as const
  ).filter((key) => grants[key] !== true);
  const overGranted = (
    [
      'anon_select',
      'anon_insert',
      'anon_update',
      'anon_delete',
      'authed_members',
      'anon_members',
    ] as const
  ).filter((key) => grants[key] === true);

  return [
    {
      name: 'authenticated is granted every documents operation it needs',
      passed: authedMissing.length === 0,
      notes:
        authedMissing.length === 0
          ? undefined
          : `missing: ${authedMissing.join(', ')}`,
    },
    {
      name: 'no role is granted more than it needs on documents or team_members',
      passed: overGranted.length === 0,
      notes:
        overGranted.length === 0
          ? undefined
          : `unnecessary grants: ${overGranted.join(', ')}`,
    },
  ];
}

type Fixtures = {
  clientA: SupabaseClient;
  clientB: SupabaseClient;
  anonClient: SupabaseClient;
  userAId: string;
  userBId: string;
  docA: string;
  docB: string;
  teamDoc: string;
  teamId: string;
};

/**
 * Signs up two users and seeds one document each plus a team document owned by
 * user A's team, as the superuser so RLS does not interfere. Rows carry a
 * per-run title so residue from the agent's own pgTAP suite can never be
 * mistaken for them.
 */
async function setupFixtures(
  ctx: LocalStackEvalContext
): Promise<{ fixtures: Fixtures } | { failure: CheckResult }> {
  const clientA = await ctx.getClient();
  const clientB = await ctx.getClient();
  const anonClient = await ctx.getClient();
  const run = randomUUID().slice(0, 8);

  const { data: authA, error: authAError } = await clientA.auth.signUp({
    email: `quickstart-rls-a-${run}@example.com`,
    password: PASSWORD,
  });
  const { data: authB, error: authBError } = await clientB.auth.signUp({
    email: `quickstart-rls-b-${run}@example.com`,
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
      failure: {
        name: 'created auth sessions',
        passed: false,
        notes: authAError?.message ?? authBError?.message ?? 'missing session',
      },
    };
  }

  const userAId = authA.user.id;
  const userBId = authB.user.id;
  const teamId = randomUUID();
  const docA = `doc-a-${run}`;
  const docB = `doc-b-${run}`;
  const teamDoc = `team-doc-${run}`;

  await execSql(
    ctx,
    stripIndent`
      INSERT INTO documents (owner_id, title, body) VALUES
        ('${userAId}', '${docA}', 'Owned by user A.'),
        ('${userBId}', '${docB}', 'Owned by user B.');

      INSERT INTO teams (id, name) VALUES ('${teamId}', 'team-${run}');
      INSERT INTO team_members (team_id, user_id) VALUES ('${teamId}', '${userAId}');
      INSERT INTO team_documents (team_id, author_id, title, body) VALUES
        ('${teamId}', '${userAId}', '${teamDoc}', 'Shared with the team.');
    `
  );

  return {
    fixtures: {
      clientA,
      clientB,
      anonClient,
      userAId,
      userBId,
      docA,
      docB,
      teamDoc,
      teamId,
    },
  };
}

async function checkDocumentVisibility(f: Fixtures): Promise<CheckResult[]> {
  const a = await f.clientA.from('documents').select('title');
  const b = await f.clientB.from('documents').select('title');
  const anon = await f.anonClient.from('documents').select('title');

  const aTitles = titlesOf(a.data);
  const bTitles = titlesOf(b.data);

  return [
    {
      name: 'user A reads their own document',
      passed: !a.error && aTitles.includes(f.docA),
      notes: a.error ? describeError(a.error) : `titles: ${aTitles.join(', ')}`,
    },
    {
      name: "user A cannot read user B's document",
      passed: !a.error && !aTitles.includes(f.docB),
      notes: a.error ? describeError(a.error) : undefined,
    },
    {
      name: "user B reads their own document and not user A's",
      passed: !b.error && bTitles.includes(f.docB) && !bTitles.includes(f.docA),
      notes: b.error ? describeError(b.error) : `titles: ${bTitles.join(', ')}`,
    },
    {
      // Either shape is a pass: RLS filters every row, or anon was never
      // granted the table at all (Postgres 42501).
      name: 'signed-out visitors read no documents',
      passed: anon.error
        ? anon.error.code === '42501'
        : (anon.data?.length ?? 0) === 0,
      notes: anon.error
        ? describeError(anon.error)
        : `${anon.data?.length ?? 0} rows`,
    },
  ];
}

async function checkDocumentWrites(
  ctx: LocalStackEvalContext,
  f: Fixtures
): Promise<CheckResult[]> {
  const ownTitle = `doc-a-new-${randomUUID().slice(0, 8)}`;
  const ownInsert = await f.clientA
    .from('documents')
    .insert({ owner_id: f.userAId, title: ownTitle });
  const foreignInsert = await f.clientA
    .from('documents')
    .insert({ owner_id: f.userBId, title: `doc-a-forged-${f.docB}` });

  // A denied UPDATE raises nothing — `using` filters the row out — so the
  // authoritative signal is that the row is unchanged afterwards.
  await f.clientA
    .from('documents')
    .update({ title: 'hijacked' })
    .eq('title', f.docB);
  await f.clientA
    .from('documents')
    .update({ owner_id: f.userBId })
    .eq('title', f.docA);

  const { rows } = await ctx.query(stripIndent`
    SELECT title, owner_id::text AS owner_id
    FROM documents
    WHERE title IN ('${f.docA}', '${f.docB}', 'hijacked')
  `);
  const docBIntact = rows.some((row) => row.title === f.docB);
  const docAStillOwned = rows.some(
    (row) => row.title === f.docA && row.owner_id === f.userAId
  );

  return [
    {
      name: 'user A can create a document they own',
      passed: !ownInsert.error,
      notes: ownInsert.error ? describeError(ownInsert.error) : undefined,
    },
    {
      name: 'user A cannot create a document owned by user B',
      passed: Boolean(foreignInsert.error),
      notes: foreignInsert.error
        ? describeError(foreignInsert.error)
        : 'insert with a forged owner_id succeeded',
    },
    {
      name: "user A cannot modify user B's document",
      passed: docBIntact,
      notes: docBIntact ? undefined : `rows now: ${JSON.stringify(rows)}`,
    },
    {
      name: 'user A cannot hand their own document to another user',
      passed: docAStillOwned,
      notes: docAStillOwned ? undefined : `rows now: ${JSON.stringify(rows)}`,
    },
  ];
}

async function checkTeamDocumentVisibility(
  f: Fixtures
): Promise<CheckResult[]> {
  const member = await f.clientA.from('team_documents').select('title');
  const outsider = await f.clientB.from('team_documents').select('title');
  const anon = await f.anonClient.from('team_documents').select('title');

  return [
    {
      name: 'a team member reads their team documents',
      passed: !member.error && titlesOf(member.data).includes(f.teamDoc),
      notes: member.error
        ? describeError(member.error)
        : `titles: ${titlesOf(member.data).join(', ')}`,
    },
    {
      name: 'a non-member reads no team documents',
      passed: outsider.error
        ? outsider.error.code === '42501'
        : !titlesOf(outsider.data).includes(f.teamDoc),
      notes: outsider.error
        ? describeError(outsider.error)
        : `titles: ${titlesOf(outsider.data).join(', ')}`,
    },
    {
      name: 'signed-out visitors read no team documents',
      passed: anon.error
        ? anon.error.code === '42501'
        : (anon.data?.length ?? 0) === 0,
      notes: anon.error
        ? describeError(anon.error)
        : `${anon.data?.length ?? 0} rows`,
    },
  ];
}

async function checkTestFilesExist(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const files = await listTestFiles(ctx);
  return {
    name: 'pgTAP test file(s) written under supabase/tests/',
    passed: files.length > 0,
    notes:
      files.length > 0
        ? `${files.length} file(s): ${files.join(', ')}`
        : 'no .sql files found under supabase/tests/',
  };
}

// Unlike build-tests-001, a failing suite fails the eval: the prompt asks for
// tests that prove the policies work, so there is no valid reason for a red
// assertion to survive.
async function checkPgTapSuitePasses(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const result = await ctx.exec('supabase test db 2>&1', {
    timeoutMs: 180_000,
  });
  const output = result.stdout + result.stderr;

  const totalMatch = output.match(/Tests[=:]\s*(\d+)/i);
  const failedMatch = output.match(/Failed:\s*(\d+)/i);
  const total = totalMatch ? parseInt(totalMatch[1], 10) : 0;
  const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;

  // The counts alone are not enough: a suite whose plan does not match the
  // assertions it ran reports `Tests: 6 Failed: 0` and still exits non-zero
  // with `Result: FAIL`, so the exit status is what decides.
  const ran = total > 0;
  return {
    name: `supabase test db runs at least ${MIN_PGTAP_TESTS} assertions and all pass`,
    passed: result.ok && ran && failed === 0 && total >= MIN_PGTAP_TESTS,
    notes: ran
      ? `${total - failed} passed, ${failed} failed, exit ${result.exitCode}`
      : `no test summary found; exit ${result.exitCode}; output: ${output.slice(0, 500)}`,
  };
}

async function checkTestCoverage(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name =
    'tests assert both the allow and the deny case per operation, for anon and authenticated';
  const files = await listTestFiles(ctx);
  if (files.length === 0) {
    return { name, passed: false, notes: 'no test files to review' };
  }

  const sources = await Promise.all(
    files.map(async (file) => `-- ${file}\n${await ctx.readFile(file)}`)
  );

  const verdict = await judge({
    input: sources.join('\n\n'),
    rubric: stripIndent`
      You are reviewing pgTAP test files written to prove that Row Level
      Security policies on a Postgres database behave correctly.

      Pass only if the tests, taken together, do all of the following:
      - Assert both an allowed and a denied outcome for each of select,
        insert, update, and delete.
      - Cover the \`anon\` role as well as the \`authenticated\` role.
      - Switch role and identity per case, for example with
        \`set local role authenticated;\` and
        \`set local request.jwt.claim.sub = '<uuid>';\`.
      - Where an update or delete is denied because the policy's \`using\`
        clause filters the target row out, assert that the row is unchanged
        rather than that an error was raised. Nothing is raised in that case.

      Expecting an error on a write is correct, and must not be penalised,
      when the denial comes from a \`with check\` violation or from a missing
      grant — both of those really do raise. Any assertion style is
      acceptable, including results_eq, is, ok, lives_ok, throws_ok, and
      policies_are, and helper wrappers around them are fine. Judge coverage,
      not phrasing.

      Fail if the tests only cover the happy path, only cover one role, never
      switch identity between cases, or assert that a \`using\`-filtered
      update or delete raises an error.
    `,
  });

  return { name, passed: verdict.passed, judgeNotes: verdict.notes };
}

async function listTestFiles(ctx: LocalStackEvalContext): Promise<string[]> {
  const result = await ctx.exec(
    "find supabase/tests -name '*.sql' 2>/dev/null"
  );
  return result.stdout.trim().split('\n').filter(Boolean);
}

/** Runs non-SELECT SQL against the local stack database as the superuser. */
async function execSql(ctx: LocalStackEvalContext, sql: string): Promise<void> {
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  const result = await ctx.exec(
    stripIndent`
      DB_URL=$(supabase status -o json | node -e 'let input = ""; process.stdin.on("data", data => input += data); process.stdin.on("end", () => console.log(JSON.parse(input).DB_URL));')
      echo ${encoded} | base64 -d | psql "$DB_URL" -v ON_ERROR_STOP=1
    `
  );

  if (!result.ok) {
    throw new Error(`SQL execution failed: ${result.stderr || result.stdout}`);
  }
}

function expressionsOf(policies: PolicyRow[]): string[] {
  return policies
    .flatMap((policy) => [policy.qual, policy.with_check])
    .filter((expression): expression is string => Boolean(expression));
}

/** `pg_policies.roles` is a `name[]`, which may arrive as `{anon,authenticated}`. */
function rolesOf(policy: PolicyRow): string[] {
  if (Array.isArray(policy.roles)) {
    return policy.roles.map((role) => String(role));
  }
  return String(policy.roles ?? '')
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function titlesOf(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data.map((row) => String((row as { title?: unknown }).title ?? ''));
}

function describeError(error: { code?: string; message: string }): string {
  return error.code ? `error ${error.code}: ${error.message}` : error.message;
}
