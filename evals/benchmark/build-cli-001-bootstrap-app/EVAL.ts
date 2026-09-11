import { randomUUID } from 'node:crypto';
import type {
  CheckResult,
  LocalStackEvalContext,
  LocalStackScorer,
} from '@supabase-evals/core';

const MIN_SEEDED_TODOS = 2;

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkProjectInitialised(ctx),
      await checkMigrationCreatesTodos(ctx),
      await checkTodosSeeded(ctx),
      await checkRlsEnabled(ctx),
      await checkAuthenticatedSelectPolicy(ctx),
      ...(await checkRestApiAccess(ctx)),
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
          name: 'scorer evaluated bootstrapped project',
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};

export default scorer;

// Scoring setup state is normally off-limits, but this scenario sets
// projectRunning: false — initialising the project is part of the agent's
// task, so config.toml existing is agent-produced state.
async function checkProjectInitialised(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const exists = await ctx.fileExists('supabase/config.toml');
  return {
    name: 'supabase project initialised (supabase/config.toml exists)',
    passed: exists,
  };
}

async function checkMigrationCreatesTodos(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'todos table is created by a migration file';
  if (!(await ctx.folderExists('supabase/migrations'))) {
    return {
      name,
      passed: false,
      notes:
        'supabase/migrations does not exist — was a Supabase project initialised?',
    };
  }
  const result = await ctx.exec('cat supabase/migrations/*.sql 2>/dev/null');
  if (!result.ok || !result.stdout.trim()) {
    return {
      name,
      passed: false,
      notes: 'no migration files found under supabase/migrations',
    };
  }
  const createsTodos =
    /create\s+table\s+(if\s+not\s+exists\s+)?("?public"?\.)?"?todos"?/i.test(
      result.stdout
    );
  return {
    name,
    passed: createsTodos,
    notes: createsTodos
      ? undefined
      : 'no migration contains CREATE TABLE for todos',
  };
}

async function checkTodosSeeded(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = `todos table exists with at least ${MIN_SEEDED_TODOS} seeded rows`;
  try {
    const { rows } = await ctx.query(
      'select count(*)::int as count from public.todos'
    );
    const count = Number(rows[0]?.count ?? 0);
    return {
      name,
      passed: count >= MIN_SEEDED_TODOS,
      notes: `found ${count} rows`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

async function checkRlsEnabled(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'row level security is enabled on todos';
  try {
    const { rows } = await ctx.query(`
      select c.relrowsecurity as rls_enabled
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'todos'
    `);
    return { name, passed: rows[0]?.rls_enabled === true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

async function checkAuthenticatedSelectPolicy(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'a SELECT policy targets the authenticated role';
  try {
    const { rows } = await ctx.query(`
      select policyname, cmd, roles
      from pg_policies
      where schemaname = 'public' and tablename = 'todos'
    `);
    const hasAuthenticatedSelect = rows.some(
      (row) =>
        (row.cmd === 'SELECT' || row.cmd === 'ALL') &&
        Array.isArray(row.roles) &&
        row.roles.includes('authenticated')
    );
    return {
      name,
      passed: hasAuthenticatedSelect,
      notes: hasAuthenticatedSelect
        ? undefined
        : `policies found: ${JSON.stringify(rows)}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

async function checkRestApiAccess(
  ctx: LocalStackEvalContext
): Promise<CheckResult[]> {
  const anonName = 'REST API returns no todos to anonymous requests';
  const authedName = 'REST API returns the todos to authenticated requests';

  let anonCheck: CheckResult;
  try {
    const anonClient = await ctx.getClient();
    const anon = await anonClient.from('todos').select('*');
    // "Anonymous requests get nothing" has two valid shapes: RLS filters the
    // rows (200 with an empty array) or the anon role has no grant at all
    // (permission denied, Postgres error 42501).
    const anonBlocked = anon.error
      ? anon.error.code === '42501'
      : anon.data?.length === 0;
    anonCheck = {
      name: anonName,
      passed: anonBlocked,
      notes: anon.error
        ? `error ${anon.error.code}: ${anon.error.message}`
        : `${anon.data?.length ?? 0} rows`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [
      { name: anonName, passed: false, notes: msg },
      { name: authedName, passed: false, notes: msg },
    ];
  }

  // Authenticate the way a real client would: sign up a user through the
  // local auth service and query with its session.
  const authedClient = await ctx.getClient();
  const signUp = await authedClient.auth.signUp({
    email: `scorer-${randomUUID().slice(0, 8)}@example.com`,
    password: 'scorer-password-123',
  });
  if (signUp.error || !signUp.data.session) {
    return [
      anonCheck,
      {
        name: authedName,
        passed: false,
        notes: `could not sign up a test user: ${signUp.error?.message ?? 'no session returned'}`,
      },
    ];
  }

  const authed = await authedClient.from('todos').select('*');
  return [
    anonCheck,
    {
      name: authedName,
      passed: !authed.error && (authed.data?.length ?? 0) >= MIN_SEEDED_TODOS,
      notes: authed.error
        ? authed.error.message
        : `${authed.data?.length ?? 0} rows`,
    },
  ];
}
