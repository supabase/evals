import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

export const SEEDED_TABLES = [
  'todos',
  'lists',
  'list_members',
  'list_items',
  'weather_stations',
  'weather_readings',
] as const;

const POLICY_FILTER_COLUMNS = [
  { table: 'todos', column: 'user_id' },
  { table: 'lists', column: 'owner_id' },
  { table: 'list_members', column: 'user_id' },
  { table: 'list_items', column: 'list_id' },
];

/** `[api] schemas` in config.toml: anything here is reachable over the API. */
const EXPOSED_SCHEMAS = new Set(['public', 'graphql_public']);

const STACK_SCHEMAS = new Set([
  'graphql',
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

export type TableState = {
  relname: string;
  relkind: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
  reloptions: string[] | null;
};

export type PolicyRow = {
  tablename: string;
  policyname: string;
  cmd: string;
  roles: unknown;
  qual: string | null;
  with_check: string | null;
};

export type FunctionRow = {
  schema_name: string;
  proname: string;
  prosecdef: boolean;
  proconfig: string[] | null;
};

/** Every relation the API exposes, not only the seeded six. */
export async function loadTableState(
  ctx: LocalStackEvalContext
): Promise<TableState[]> {
  const { rows } = await ctx.query(stripIndent`
    SELECT
      c.relname,
      c.relkind::text AS relkind,
      c.relrowsecurity,
      c.relforcerowsecurity,
      c.reloptions
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      )
  `);
  return rows as TableState[];
}

export async function loadPolicies(
  ctx: LocalStackEvalContext
): Promise<PolicyRow[]> {
  const { rows } = await ctx.query(stripIndent`
    SELECT tablename, policyname, cmd, roles, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
  `);
  return rows as PolicyRow[];
}

/**
 * Functions the agent could have created: everything outside the schemas the
 * stack ships. The exposed schemas stay in scope, because a security definer
 * function there is the case worth catching.
 */
export async function loadCandidateFunctions(
  ctx: LocalStackEvalContext
): Promise<FunctionRow[]> {
  const { rows } = await ctx.query(stripIndent`
    SELECT
      n.nspname AS schema_name,
      p.proname,
      p.prosecdef,
      p.proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
  `);
  return (rows as FunctionRow[]).filter(
    (row) =>
      !STACK_SCHEMAS.has(row.schema_name) &&
      !row.schema_name.startsWith('pg_') &&
      !row.schema_name.startsWith('_')
  );
}

// Ranges over `public` rather than the seeded names, so a table the agent adds
// is measured too. SEEDED_TABLES is only the must-exist list.
export function checkRlsEnabled(tables: TableState[]): CheckResult {
  const absent = SEEDED_TABLES.filter(
    (name) => !tables.some((t) => t.relname === name)
  );
  const unprotected = tables
    .filter((t) => t.relkind === 'r' || t.relkind === 'p')
    .filter((t) => t.relrowsecurity !== true)
    .map((t) => t.relname);

  return {
    name: 'row level security is enabled on every table in the public schema',
    passed: absent.length === 0 && unprotected.length === 0,
    notes:
      absent.length === 0 && unprotected.length === 0
        ? undefined
        : [
            absent.length > 0
              ? `seeded table missing: ${absent.join(', ')}`
              : null,
            unprotected.length > 0
              ? `RLS not enabled on: ${unprotected.join(', ')}`
              : null,
          ]
            .filter(Boolean)
            .join('; '),
  };
}

// A view runs as its owner unless security_invoker is set, so a view over a
// protected table hands out everything the policies were meant to withhold.
export function checkViewsRunAsInvoker(tables: TableState[]): CheckResult {
  const views = tables.filter((t) => t.relkind === 'v');
  const matviews = tables
    .filter((t) => t.relkind === 'm')
    .map((t) => t.relname);
  const leaky = views
    .filter(
      (t) =>
        !(t.reloptions ?? []).some((option) =>
          /^security_invoker\s*=\s*(true|on|yes|1)$/i.test(option)
        )
    )
    .map((t) => t.relname);

  return {
    name: 'every view in the public schema runs as the invoker, and none is materialized',
    passed: leaky.length === 0 && matviews.length === 0,
    notes:
      leaky.length === 0 && matviews.length === 0
        ? views.length === 0
          ? 'no views created'
          : `verified ${views.map((v) => v.relname).join(', ')}`
        : [
            leaky.length > 0 ? `bypasses RLS: ${leaky.join(', ')}` : null,
            matviews.length > 0
              ? `materialized, so row level security never applies: ${matviews.join(', ')}`
              : null,
          ]
            .filter(Boolean)
            .join('; '),
  };
}

export async function checkMatviewsHiddenFromClients(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT c.relname AS table_name, r.rolname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
    WHERE n.nspname = 'public'
      AND c.relkind = 'm'
      AND has_table_privilege(r.rolname, c.oid, 'SELECT')
  `);
  const readable = rows.map(
    (row) => `${String(row.rolname)} on ${String(row.table_name)}`
  );
  return {
    name: 'no client role can read a materialized view',
    passed: readable.length === 0,
    notes:
      readable.length === 0
        ? undefined
        : `select granted: ${readable.join(', ')}`,
  };
}

export function checkPoliciesScopedToRole(policies: PolicyRow[]): CheckResult {
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

export function checkOnePolicyPerOperation(policies: PolicyRow[]): CheckResult {
  const todoPolicies = policies.filter((p) => p.tablename === 'todos');
  const commands = new Set(todoPolicies.map((p) => p.cmd.toUpperCase()));
  const missing = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].filter(
    (cmd) => !commands.has(cmd)
  );
  const catchAll = commands.has('ALL');
  return {
    name: 'todos has a separate policy per operation, with no FOR ALL catch-all',
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

export function checkUpdatePoliciesHaveBothClauses(
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
export function checkAuthCallsWrapped(policies: PolicyRow[]): CheckResult {
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

export function checkPoliciesIgnoreUserMetadata(
  policies: PolicyRow[]
): CheckResult {
  const offenders = policies.filter((policy) =>
    expressionsOf([policy]).some((expression) =>
      /user_metadata/i.test(expression)
    )
  );
  return {
    name: 'no policy reads user_metadata, which its own subject can write',
    passed: offenders.length === 0,
    notes:
      offenders.length === 0
        ? undefined
        : `reads user_metadata: ${offenders.map((p) => `${p.tablename}.${p.policyname}`).join(', ')}`,
  };
}

export async function checkPolicyColumnsIndexed(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT c.relname AS table_name, a.attname AS column_name
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_am am ON am.oid = ic.relam
    WHERE n.nspname = 'public'
      AND i.indisvalid
      AND am.amname = 'btree'
      AND i.indpred IS NULL
  `);
  const indexed = new Set(
    rows.map((row) => `${String(row.table_name)}.${String(row.column_name)}`)
  );
  const missing = POLICY_FILTER_COLUMNS.filter(
    ({ table, column }) => !indexed.has(`${table}.${column}`)
  );
  return {
    name: 'columns the policies filter on have a btree index',
    passed: missing.length === 0,
    notes:
      missing.length === 0
        ? undefined
        : `no complete btree index leading with: ${missing.map((c) => `${c.table}.${c.column}`).join(', ')}`,
  };
}

// Scoped to the two ways a security definer function is unsafe, not to any
// particular design. Membership has more than one safe implementation, and
// whether it holds is proven by the access probes.
export function checkSecurityDefinersAreSafe(
  functions: FunctionRow[]
): CheckResult {
  const name =
    'any security definer function is out of the exposed schemas and pins search_path';
  const secdef = functions.filter((fn) => fn.prosecdef);
  const exposed = secdef.filter((fn) => EXPOSED_SCHEMAS.has(fn.schema_name));
  const unpinned = secdef.filter((fn) => !hasEmptySearchPath(fn));

  return {
    name,
    passed: exposed.length === 0 && unpinned.length === 0,
    notes:
      exposed.length === 0 && unpinned.length === 0
        ? secdef.length > 0
          ? `verified ${secdef.map(describeFunction).join(', ')}`
          : 'no security definer function was created'
        : [
            exposed.length > 0
              ? `callable over the API: ${exposed.map(describeFunction).join(', ')}`
              : null,
            unpinned.length > 0
              ? `search_path not pinned: ${unpinned.map(describeFunction).join(', ')}`
              : null,
          ]
            .filter(Boolean)
            .join('; '),
  };
}

function hasEmptySearchPath(fn: FunctionRow): boolean {
  const setting = (fn.proconfig ?? []).find((entry) =>
    entry.startsWith('search_path=')
  );
  if (setting === undefined) return false;
  const value = setting.slice('search_path='.length).trim();
  return value === '' || value === '""' || value === "''";
}

const WEATHER_TABLES = new Set(['weather_stations', 'weather_readings']);

type GrantRow = { table_name: string; rolname: string; priv: string };

// Ranges over `public` so an extra table the agent leaves behind is measured
// too, rather than only the seeded names.
export async function checkGrants(
  ctx: LocalStackEvalContext
): Promise<CheckResult[]> {
  const { rows } = await ctx.query(stripIndent`
    SELECT c.relname AS table_name, r.rolname, p.priv
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
    CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND has_table_privilege(r.rolname, c.oid, p.priv)
  `);
  const granted = rows as GrantRow[];
  const describe = (g: GrantRow) =>
    `${g.rolname} ${g.priv.toLowerCase()} on ${g.table_name}`;

  const anonWrites = granted.filter((g) => g.rolname === 'anon');
  const feedWrites = granted.filter((g) => WEATHER_TABLES.has(g.table_name));

  return [
    {
      name: 'anon holds no write grant anywhere in the public schema',
      passed: anonWrites.length === 0,
      notes:
        anonWrites.length === 0
          ? undefined
          : `still granted: ${anonWrites.map(describe).join(', ')}`,
    },
    {
      name: 'no client role holds a write grant on the weather feed',
      passed: feedWrites.length === 0,
      notes:
        feedWrites.length === 0
          ? undefined
          : `still granted: ${feedWrites.map(describe).join(', ')}`,
    },
  ];
}

function describeFunction(fn: FunctionRow): string {
  return `${fn.schema_name}.${fn.proname}`;
}

export function expressionsOf(policies: PolicyRow[]): string[] {
  return policies
    .flatMap((policy) => [policy.qual, policy.with_check])
    .filter((expression): expression is string => Boolean(expression));
}

/** `pg_policies.roles` is a `name[]`, which may arrive as `{anon,authenticated}`. */
export function rolesOf(policy: PolicyRow): string[] {
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
