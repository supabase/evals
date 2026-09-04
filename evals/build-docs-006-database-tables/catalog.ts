import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

/** The tables `local/src/queries.ts` builds against. The seed fixes these names. */
export const CONTRACT_TABLES = [
  'routines',
  'routine_logs',
  'routine_library',
] as const;

export type TableState = {
  relname: string;
  relkind: string;
  relrowsecurity: boolean;
};

export type PolicyRow = {
  tablename: string;
  policyname: string;
};

/**
 * Every relation in the exposed schema, not only the three the app names — an
 * extra table the agent invented is just as reachable over the Data API.
 *
 * The `pg_depend` anti-join drops objects an extension owns: pgTAP creates
 * views in `public` when it is installed there, and those are not the agent's.
 */
export async function loadTableState(
  ctx: LocalStackEvalContext
): Promise<TableState[]> {
  const { rows } = await ctx.query(stripIndent`
    SELECT
      c.relname,
      c.relkind::text AS relkind,
      c.relrowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
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
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
  `);
  return rows as PolicyRow[];
}

/**
 * The central catalog claim. Named for the class rather than the method: the
 * page could close this gap by linking the Row Level Security guide, by showing
 * `alter table ... enable row level security` inline, or by moving the tables
 * into an unexposed schema, and only the first two land here.
 */
export function checkRlsEnabled(tables: TableState[]): CheckResult {
  const absent = CONTRACT_TABLES.filter(
    (name) => !tables.some((table) => table.relname === name)
  );
  const unprotected = tables
    .filter((table) => table.relrowsecurity !== true)
    .map((table) => table.relname);
  const passed = absent.length === 0 && unprotected.length === 0;

  return {
    name: 'row level security is enabled on every table in the public schema',
    passed,
    notes: passed
      ? undefined
      : [
          absent.length > 0
            ? `the app's tables are missing: ${absent.join(', ')}`
            : null,
          unprotected.length > 0
            ? `row level security not enabled on: ${unprotected.join(', ')}`
            : null,
        ]
          .filter(Boolean)
          .join('; '),
  };
}

/**
 * Enabling row level security and stopping there locks the app out of its own
 * data, which is the failure FDBKIN-5041 describes. Kept to a low bar — one
 * policy — because whether the policies are *right* is what the behavioral
 * probes settle, and an ambitious check here would fail the whole eval.
 */
export function checkProtectedTablesHavePolicies(
  tables: TableState[],
  policies: PolicyRow[]
): CheckResult {
  const withPolicy = new Set(policies.map((policy) => policy.tablename));
  const bare = tables
    .filter((table) => table.relrowsecurity === true)
    .filter((table) => !withPolicy.has(table.relname))
    .map((table) => table.relname);
  const enabled = tables.filter((table) => table.relrowsecurity === true);

  return {
    name: 'every table with row level security enabled carries at least one policy',
    passed: enabled.length > 0 && bare.length === 0,
    notes:
      enabled.length === 0
        ? 'no table has row level security enabled, so there is nothing to police'
        : bare.length === 0
          ? undefined
          : `enabled with no policy, so nothing reaches these tables: ${bare.join(', ')}`,
  };
}
