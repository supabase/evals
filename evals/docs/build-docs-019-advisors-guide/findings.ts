import type { CheckResult } from '@supabase-evals/core';

export type Query = (
  sql: string
) => Promise<{ rows: Record<string, unknown>[] }>;

export const FINDINGS_CHECK =
  'no relationship is flagged as missing a covering index';

const EXCLUDED_SCHEMAS = [
  '_timescaledb_cache',
  '_timescaledb_catalog',
  '_timescaledb_config',
  '_timescaledb_internal',
  'auth',
  'cron',
  'extensions',
  'graphql',
  'graphql_public',
  'information_schema',
  'net',
  'pgmq',
  'pgroonga',
  'pgsodium',
  'pgsodium_masks',
  'pgtle',
  'pgbouncer',
  'pg_catalog',
  'realtime',
  'repack',
  'storage',
  'supabase_functions',
  'supabase_migrations',
  'tiger',
  'topology',
  'vault',
]
  .map((schema) => `'${schema}'`)
  .join(', ');

export const UNINDEXED_FOREIGN_KEYS_SQL = `
  with foreign_keys as (
    select ns.nspname as schema_name, cl.relname as table_name, cl.oid as table_oid,
           ct.conname as fkey_name, ct.conkey as col_attnums
    from pg_catalog.pg_constraint ct
    join pg_catalog.pg_class cl on ct.conrelid = cl.oid
    join pg_catalog.pg_namespace ns on cl.relnamespace = ns.oid
    left join pg_catalog.pg_depend d
      on d.objid = cl.oid and d.deptype = 'e' and d.classid = 'pg_catalog.pg_class'::regclass
    where ct.contype = 'f' and d.objid is null
      and ns.nspname not in ('pg_catalog', 'information_schema', 'auth', 'storage', 'vault', 'extensions')
  ),
  index_ as (
    select pi.indrelid as table_oid, indexrelid::regclass as index_,
           string_to_array(indkey::text, ' ')::smallint[] as col_attnums
    from pg_catalog.pg_index pi
    where indisvalid
  )
  select fk.schema_name || '.' || fk.table_name || ' ' || fk.fkey_name as finding
  from foreign_keys fk
  left join index_ idx
    on fk.table_oid = idx.table_oid
    and fk.col_attnums = idx.col_attnums[1:array_length(fk.col_attnums, 1)]
  where idx.index_ is null
    and fk.schema_name not in (${EXCLUDED_SCHEMAS})
  order by 1
`;

export const TABLES_CHECK =
  'the seeded tables are still ordinary tables in public';

const SEEDED_TABLES = ['clinics', 'rooms', 'practitioners', 'appointments'];

export const TABLE_KINDS_SQL = `
  select seeded.name || ' is ' || coalesce(
    case cl.relkind when 'v' then 'a view' when 'm' then 'a materialized view'
      when 'f' then 'a foreign table' else 'relkind ' || cl.relkind::text end,
    'missing'
  ) as problem
  from unnest(array[${SEEDED_TABLES.map((name) => `'public.${name}'`).join(', ')}]) as seeded(name)
  left join pg_catalog.pg_class cl on cl.oid = to_regclass(seeded.name)
  where cl.relkind is distinct from 'r' and cl.relkind is distinct from 'p'
  order by 1
`;

export async function checkSeededTablesAreTables(
  query: Query
): Promise<CheckResult> {
  const { rows } = await query(TABLE_KINDS_SQL);
  const problems = rows.map((row) => String(row.problem));
  return {
    name: TABLES_CHECK,
    passed: problems.length === 0,
    notes: problems.length === 0 ? 'all four are tables' : problems.join(', '),
  };
}

export async function checkNoUnindexedForeignKeys(
  query: Query
): Promise<CheckResult> {
  const { rows } = await query(UNINDEXED_FOREIGN_KEYS_SQL);
  const findings = rows.map((row) => String(row.finding));
  return {
    name: FINDINGS_CHECK,
    passed: findings.length === 0,
    notes:
      findings.length === 0
        ? 'none flagged'
        : `still flagged: ${findings.join(', ')}`,
  };
}
