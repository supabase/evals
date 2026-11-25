/**
 * Splinter-shaped advisor lints, computed from the PGlite catalog.
 *
 * Each lint mirrors one hosted rule (supabase/splinter): same name, level,
 * category and remediation URL, so an mcp tool that groups or caps lints sees
 * the shape it sees hosted. The SQL is a simplified port: it covers the common
 * form of each rule, not every edge case splinter handles. Extend from an eval
 * that needs it, not speculatively.
 *
 * rls_disabled_in_public stays in debugging.ts unchanged; existing evals
 * depend on its exact remediation text.
 */

type Level = 'INFO' | 'WARN' | 'ERROR';
type Category = 'SECURITY' | 'PERFORMANCE';

type Row = Record<string, unknown> & { schema: string; name: string };

export type AdvisorLint = {
  name: string;
  title: string;
  level: Level;
  facing: 'EXTERNAL';
  categories: Category[];
  description: string;
  detail: string;
  remediation: string;
  metadata: { schema: string; name: string; type: string };
  cache_key: string;
};

type LintDef = {
  name: string;
  code: string;
  title: string;
  level: Level;
  category: Category;
  description: string;
  objectType: string;
  sql: string;
  detail: (row: Row) => string;
  key: (row: Row) => string;
};

const USER_SCHEMA = String.raw`n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'auth', 'extensions', 'storage', 'supabase_functions', 'supabase_migrations') AND n.nspname NOT LIKE 'pg\_%'`;

const POLICY_SCHEMA = String.raw`p.schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'auth', 'extensions', 'storage', 'supabase_functions', 'supabase_migrations')`;

// An auth helper call not wrapped in a subselect is re-evaluated per row.
const AUTH_CALL = String.raw`auth\.(uid|jwt|role|email)\(\)`;
const WRAPPED_AUTH_CALL = String.raw`select\s+auth\.(uid|jwt|role|email)\(\)`;

const q = (ident: string) => `"${ident}"`;
const rel = (row: Row) => `${q(row.schema)}.${q(row.name)}`;

const LINTS: LintDef[] = [
  {
    name: 'policy_exists_rls_disabled',
    code: '0007',
    title: 'Policy Exists RLS Disabled',
    level: 'ERROR',
    category: 'SECURITY',
    description:
      'Detects cases where row level security (RLS) policies have been created, but RLS has not been enabled for the underlying table.',
    objectType: 'table',
    sql: `
SELECT n.nspname AS schema, c.relname AS name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND ${USER_SCHEMA}
  AND NOT c.relrowsecurity
  AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
ORDER BY 1, 2`,
    detail: (r) =>
      `Table ${rel(r)} has RLS policies but RLS is not enabled on the table.`,
    key: (r) => `policy_exists_rls_disabled_${r.schema}_${r.name}`,
  },
  {
    name: 'rls_enabled_no_policy',
    code: '0008',
    title: 'RLS Enabled No Policy',
    level: 'INFO',
    category: 'SECURITY',
    description:
      'Detects cases where row level security (RLS) has been enabled on a table but no RLS policies have been created.',
    objectType: 'table',
    sql: `
SELECT n.nspname AS schema, c.relname AS name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND ${USER_SCHEMA}
  AND c.relrowsecurity
  AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
ORDER BY 1, 2`,
    detail: (r) =>
      `Table ${rel(r)} has RLS enabled, but no policies exist`,
    key: (r) => `rls_enabled_no_policy_${r.schema}_${r.name}`,
  },
  {
    name: 'security_definer_view',
    code: '0010',
    title: 'Security Definer View',
    level: 'ERROR',
    category: 'SECURITY',
    description:
      'Detects views defined with the SECURITY DEFINER property. These views enforce Postgres permissions and row level security policies (RLS) of the view creator, rather than that of the querying user',
    objectType: 'view',
    sql: `
SELECT n.nspname AS schema, c.relname AS name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'v' AND n.nspname = 'public'
  AND NOT coalesce(c.reloptions, '{}') && ARRAY['security_invoker=true', 'security_invoker=on', 'security_invoker=1']
ORDER BY 1, 2`,
    detail: (r) =>
      `View ${rel(r)} is defined with the SECURITY DEFINER property`,
    key: (r) => `security_definer_view_${r.schema}_${r.name}`,
  },
  {
    name: 'function_search_path_mutable',
    code: '0011',
    title: 'Function Search Path Mutable',
    level: 'WARN',
    category: 'SECURITY',
    description: 'Detects functions where the search_path parameter is not set.',
    objectType: 'function',
    sql: `
SELECT n.nspname AS schema, p.proname AS name, p.oid::regprocedure::text AS signature
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prokind = 'f' AND ${USER_SCHEMA}
  AND NOT EXISTS (
    SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) AS cfg WHERE cfg LIKE 'search_path=%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
  )
ORDER BY 1, 2, 3`,
    detail: (r) =>
      `Function ${rel(r)} has a role mutable search_path`,
    key: (r) =>
      `function_search_path_mutable_${r.schema}_${r.name}_${String(r.signature)}`,
  },
  {
    name: 'materialized_view_in_api',
    code: '0016',
    title: 'Materialized View in API',
    level: 'WARN',
    category: 'SECURITY',
    description:
      'Detects materialized views that are accessible over the Data APIs.',
    objectType: 'materialized view',
    sql: `
SELECT n.nspname AS schema, c.relname AS name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'm' AND n.nspname = 'public'
ORDER BY 1, 2`,
    detail: (r) =>
      `Materialized view ${rel(r)} is selectable by anon or authenticated roles`,
    key: (r) => `materialized_view_in_api_${r.schema}_${r.name}`,
  },
  {
    name: 'unindexed_foreign_keys',
    code: '0001',
    title: 'Unindexed foreign keys',
    level: 'INFO',
    category: 'PERFORMANCE',
    description:
      'Identifies foreign key constraints without a covering index, which can impact database performance.',
    objectType: 'table',
    sql: `
SELECT n.nspname AS schema, c.relname AS name, con.conname AS fkey_name
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE con.contype = 'f' AND ${USER_SCHEMA}
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = con.conrelid
      AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(con.conkey)] = con.conkey
  )
ORDER BY 1, 2, 3`,
    detail: (r) =>
      `Table ${rel(r)} has a foreign key ${q(String(r.fkey_name))} without a covering index. This can lead to suboptimal query performance.`,
    key: (r) =>
      `unindexed_foreign_keys_${r.schema}_${r.name}_${String(r.fkey_name)}`,
  },
  {
    name: 'auth_rls_initplan',
    code: '0003',
    title: 'Auth RLS Initialization Plan',
    level: 'WARN',
    category: 'PERFORMANCE',
    description:
      "Detects if calls to `current_setting()` and `auth.<function>()` in RLS policies are being unnecessarily re-evaluated for each row",
    objectType: 'table',
    sql: String.raw`
SELECT p.schemaname AS schema, p.tablename AS name, p.policyname AS policy_name
FROM pg_policies p
WHERE ${POLICY_SCHEMA}
  AND (
    (coalesce(p.qual, '') ~ '${AUTH_CALL}' AND coalesce(p.qual, '') !~* '${WRAPPED_AUTH_CALL}')
    OR (coalesce(p.with_check, '') ~ '${AUTH_CALL}' AND coalesce(p.with_check, '') !~* '${WRAPPED_AUTH_CALL}')
  )
ORDER BY 1, 2, 3`,
    detail: (r) =>
      `Table ${rel(r)} has a row level security policy ${q(String(r.policy_name))} that re-evaluates auth.<function>() for each row. This produces suboptimal query performance at scale. Resolve the issue by replacing \`auth.<function>()\` with \`(select auth.<function>())\`.`,
    key: (r) =>
      `auth_rls_init_plan_${r.schema}_${r.name}_${String(r.policy_name)}`,
  },
  {
    name: 'no_primary_key',
    code: '0004',
    title: 'No Primary Key',
    level: 'INFO',
    category: 'PERFORMANCE',
    description:
      'Detects if a table does not have a primary key. Tables without a primary key can be inefficient to interact with at scale.',
    objectType: 'table',
    sql: `
SELECT n.nspname AS schema, c.relname AS name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND ${USER_SCHEMA}
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint con WHERE con.conrelid = c.oid AND con.contype = 'p'
  )
ORDER BY 1, 2`,
    detail: (r) => `Table ${rel(r)} does not have a primary key`,
    key: (r) => `no_primary_key_${r.schema}_${r.name}`,
  },
  {
    name: 'multiple_permissive_policies',
    code: '0006',
    title: 'Multiple Permissive Policies',
    level: 'WARN',
    category: 'PERFORMANCE',
    description:
      'Detects if multiple permissive row level security policies are present on a table for the same `role` and `action` (e.g. insert). Multiple permissive policies are suboptimal for performance as each policy must be executed for every relevant query.',
    objectType: 'table',
    sql: `
SELECT p.schemaname AS schema, p.tablename AS name, r.role::text AS role, a.action,
  array_agg(p.policyname::text ORDER BY p.policyname) AS policies
FROM pg_policies p
CROSS JOIN LATERAL unnest(p.roles) AS r(role)
CROSS JOIN LATERAL unnest(
  CASE WHEN p.cmd = 'ALL' THEN ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] ELSE ARRAY[p.cmd] END
) AS a(action)
WHERE p.permissive = 'PERMISSIVE' AND ${POLICY_SCHEMA}
GROUP BY 1, 2, 3, 4
HAVING count(*) > 1
ORDER BY 1, 2, 3, 4`,
    detail: (r) =>
      `Table ${rel(r)} has multiple permissive policies for role \`${String(r.role)}\` for action \`${String(r.action)}\`. Policies include \`${JSON.stringify(r.policies)}\``,
    key: (r) =>
      `multiple_permissive_policies_${r.schema}_${r.name}_${String(r.role)}_${String(r.action)}`,
  },
  {
    name: 'duplicate_index',
    code: '0009',
    title: 'Duplicate Index',
    level: 'WARN',
    category: 'PERFORMANCE',
    description:
      'Detects cases where two ore more identical indexes exist.',
    objectType: 'table',
    sql: `
SELECT n.nspname AS schema, c.relname AS name,
  array_agg(ic.relname::text ORDER BY ic.relname) AS indexes
FROM pg_index i
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_class ic ON ic.oid = i.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE ${USER_SCHEMA}
GROUP BY n.nspname, c.relname, i.indkey::text, i.indclass::text, i.indoption::text, i.indisunique,
  coalesce(pg_get_expr(i.indexprs, i.indrelid), ''),
  coalesce(pg_get_expr(i.indpred, i.indrelid), '')
HAVING count(*) > 1
ORDER BY 1, 2`,
    detail: (r) =>
      `Table ${rel(r)} has identical indexes ${JSON.stringify(r.indexes)}. Drop all except one of them`,
    key: (r) =>
      `duplicate_index_${r.schema}_${r.name}_${(r.indexes as string[]).join('_')}`,
  },
];

function remediationUrl(def: LintDef): string {
  return `https://supabase.com/docs/guides/database/database-linter?lint=${def.code}_${def.name}`;
}

function isRow(v: unknown): v is Row {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Row).schema === 'string' &&
    typeof (v as Row).name === 'string'
  );
}

export async function runAdvisorLints(
  category: Category,
  query: (sql: string) => Promise<unknown[]>
): Promise<AdvisorLint[]> {
  const lints: AdvisorLint[] = [];
  for (const def of LINTS.filter((d) => d.category === category)) {
    const rows = (await query(def.sql)).filter(isRow);
    for (const row of rows) {
      lints.push({
        name: def.name,
        title: def.title,
        level: def.level,
        facing: 'EXTERNAL',
        categories: [def.category],
        description: def.description,
        detail: def.detail(row),
        remediation: remediationUrl(def),
        metadata: { schema: row.schema, name: row.name, type: def.objectType },
        cache_key: def.key(row),
      });
    }
  }
  return lints;
}
