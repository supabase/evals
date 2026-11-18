import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { parse } from 'smol-toml';
import { NAMES } from './names.js';

export const REPLIES = 'ticket_replies';
export const NOTES = 'ticket_notes';
export const CLOSE_STALE = 'close_stale_tickets';
export const SEARCH = 'search_help_articles';

export type Objects = {
  replies: boolean;
  notes: boolean;
  closeStale: boolean;
};

const yes = (value: unknown) => value === true || value === 't';

export async function loadObjects(
  ctx: LocalStackEvalContext
): Promise<Objects> {
  const { rows } = await ctx.query(`
    SELECT
      to_regclass('public.${REPLIES}') IS NOT NULL AS replies,
      to_regclass('public.${NOTES}') IS NOT NULL AS notes,
      EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = '${CLOSE_STALE}'
          AND p.pronargs = 0
      ) AS close_stale
  `);
  const row = rows[0] ?? {};
  return {
    replies: yes(row.replies),
    notes: yes(row.notes),
    closeStale: yes(row.close_stale),
  };
}

export function checkObjectsExist(objects: Objects): CheckResult {
  const missing = [
    objects.replies ? undefined : `table ${REPLIES}`,
    objects.notes ? undefined : `table ${NOTES}`,
    objects.closeStale ? undefined : `function ${CLOSE_STALE}() in public`,
  ].filter((item): item is string => item !== undefined);

  return {
    name: NAMES.objects,
    passed: missing.length === 0,
    notes:
      missing.length === 0
        ? 'all three exist in public'
        : `missing: ${missing.join(', ')}`,
  };
}

// Schemas the platform ships. The Data API's own are not the agent's to widen,
// and their functions are not part of what this eval measures.
const PLATFORM_SCHEMAS = new Set(['graphql_public']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// `public` plus any schema the agent added to the config's exposed list. A
// source-level read of config.toml, so a schema exposed some other way is not
// seen. The note says which it used.
async function apiSchemas(
  ctx: LocalStackEvalContext
): Promise<{ schemas: string[]; note: string }> {
  try {
    const config = parse(await ctx.readFile('supabase/config.toml')) as {
      api?: { schemas?: unknown };
    };
    const listed = Array.isArray(config.api?.schemas)
      ? config.api.schemas.filter(
          (schema): schema is string =>
            typeof schema === 'string' && IDENTIFIER.test(schema)
        )
      : [];
    const schemas = [
      ...new Set(['public', ...listed.filter((s) => !PLATFORM_SCHEMAS.has(s))]),
    ];
    return { schemas, note: `schemas from config.toml: ${schemas.join(', ')}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      schemas: ['public'],
      note: `could not read config.toml (${message.slice(0, 80)}), checked public only`,
    };
  }
}

// Whitelist, not blacklist: every function a visitor can run in the schemas the
// API serves, minus the one the project gave them. Trigger functions are not
// callable through the API, and an extension's own functions are not the
// agent's.
export async function checkAnonRunsOnlyTheSearch(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = NAMES.visitorFunctions;
  const { schemas, note } = await apiSchemas(ctx);
  const list = schemas.map((schema) => `'${schema}'`).join(', ');

  const { rows } = await ctx.query(`
    SELECT n.nspname AS schema_name,
           p.proname AS name,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN (${list})
      AND p.prokind IN ('f', 'p')
      AND p.prorettype <> 'trigger'::regtype
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass
          AND d.objid = p.oid
          AND d.deptype = 'e'
      )
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT (n.nspname = 'public' AND p.proname = '${SEARCH}')
    ORDER BY 1, 2
  `);

  const open = rows.map(
    (row) => `${row.schema_name}.${row.name}(${row.args ?? ''})`
  );
  return {
    name,
    passed: open.length === 0,
    notes:
      open.length === 0
        ? `none. ${note}`
        : `a signed-out visitor can run: ${open.join(', ')}. ${note}`,
  };
}
