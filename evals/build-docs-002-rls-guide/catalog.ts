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
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
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

export async function loadTableState(
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

export function checkRlsEnabled(tables: TableState[]): CheckResult {
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

export function checkListItemsAvoidsJoin(policies: PolicyRow[]): CheckResult {
  const expressions = expressionsOf(
    policies.filter((p) => p.tablename === 'list_items')
  );
  const name = 'list_items policies do not select from list_members inline';

  if (expressions.length === 0) {
    return { name, passed: false, notes: 'no policies on list_items' };
  }

  const joined = expressions.filter((expression) =>
    /\bFROM\s+(public\.)?list_members\b/i.test(expression)
  );
  return {
    name,
    passed: joined.length === 0,
    notes:
      joined.length === 0
        ? undefined
        : `${joined.length} list_items policy expression(s) join list_members directly`,
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

export async function checkGrants(
  ctx: LocalStackEvalContext
): Promise<CheckResult[]> {
  const { rows } = await ctx.query(stripIndent`
    SELECT
      has_table_privilege('anon', 'public.todos', 'INSERT') AS anon_todos_insert,
      has_table_privilege('anon', 'public.todos', 'UPDATE') AS anon_todos_update,
      has_table_privilege('anon', 'public.todos', 'DELETE') AS anon_todos_delete,
      has_table_privilege('anon', 'public.lists', 'INSERT') AS anon_lists_insert,
      has_table_privilege('anon', 'public.lists', 'UPDATE') AS anon_lists_update,
      has_table_privilege('anon', 'public.lists', 'DELETE') AS anon_lists_delete,
      has_table_privilege('anon', 'public.list_members', 'INSERT') AS anon_members_insert,
      has_table_privilege('anon', 'public.list_members', 'UPDATE') AS anon_members_update,
      has_table_privilege('anon', 'public.list_members', 'DELETE') AS anon_members_delete,
      has_table_privilege('anon', 'public.list_items', 'INSERT') AS anon_items_insert,
      has_table_privilege('anon', 'public.list_items', 'UPDATE') AS anon_items_update,
      has_table_privilege('anon', 'public.list_items', 'DELETE') AS anon_items_delete,
      has_table_privilege('anon', 'public.weather_stations', 'INSERT') AS anon_stations_insert,
      has_table_privilege('anon', 'public.weather_stations', 'UPDATE') AS anon_stations_update,
      has_table_privilege('anon', 'public.weather_stations', 'DELETE') AS anon_stations_delete,
      has_table_privilege('anon', 'public.weather_readings', 'INSERT') AS anon_readings_insert,
      has_table_privilege('anon', 'public.weather_readings', 'UPDATE') AS anon_readings_update,
      has_table_privilege('anon', 'public.weather_readings', 'DELETE') AS anon_readings_delete,
      has_table_privilege('authenticated', 'public.weather_stations', 'INSERT') AS authed_stations_insert,
      has_table_privilege('authenticated', 'public.weather_stations', 'UPDATE') AS authed_stations_update,
      has_table_privilege('authenticated', 'public.weather_stations', 'DELETE') AS authed_stations_delete,
      has_table_privilege('authenticated', 'public.weather_readings', 'INSERT') AS authed_readings_insert,
      has_table_privilege('authenticated', 'public.weather_readings', 'UPDATE') AS authed_readings_update,
      has_table_privilege('authenticated', 'public.weather_readings', 'DELETE') AS authed_readings_delete
  `);
  const grants = rows[0] ?? {};
  const granted = (key: string) => grants[key] === true;

  const anonWrites = [
    'anon_todos_insert',
    'anon_todos_update',
    'anon_todos_delete',
    'anon_lists_insert',
    'anon_lists_update',
    'anon_lists_delete',
    'anon_members_insert',
    'anon_members_update',
    'anon_members_delete',
    'anon_items_insert',
    'anon_items_update',
    'anon_items_delete',
  ].filter(granted);

  const feedWrites = [
    'anon_stations_insert',
    'anon_stations_update',
    'anon_stations_delete',
    'anon_readings_insert',
    'anon_readings_update',
    'anon_readings_delete',
    'authed_stations_insert',
    'authed_stations_update',
    'authed_stations_delete',
    'authed_readings_insert',
    'authed_readings_update',
    'authed_readings_delete',
  ].filter(granted);

  return [
    {
      name: "anon's default write grants are revoked on the to-do tables",
      passed: anonWrites.length === 0,
      notes:
        anonWrites.length === 0
          ? undefined
          : `still granted by default: ${anonWrites.join(', ')}`,
    },
    {
      name: "both client roles' default write grants are revoked on the weather feed",
      passed: feedWrites.length === 0,
      notes:
        feedWrites.length === 0
          ? undefined
          : `still granted by default: ${feedWrites.join(', ')}`,
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
