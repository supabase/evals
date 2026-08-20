import { stripIndent } from 'common-tags';
import type {
  CheckResult,
  LocalStackEvalContext,
  LocalStackScorer,
} from '@supabase-evals/core';

const SEEDED_MIGRATION = '20260101000000_create_products.sql';

const scorer: LocalStackScorer = async (ctx) => {
  const checks: CheckResult[] = [
    checkDeclarativeSyncUsed(ctx),
    await checkSchemaKeptDescription(ctx),
    await checkMigrationCapturesDescription(ctx),
    await checkDescriptionColumnLive(ctx),
    await checkGeneratedSqlClean(ctx),
  ];

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
};

export default scorer;

/** `db diff` ignores declarative edits; the planner for this tree is sync. */
function checkDeclarativeSyncUsed(ctx: LocalStackEvalContext): CheckResult {
  const name =
    'supabase db schema declarative sync used to generate the migration';
  const used = ctx.toolCalls.some((tc) => {
    const cmd = shellCommand(tc);
    if (!/supabase\s+db\s+schema\s+declarative\s+sync/.test(cmd)) return false;
    if (/(?:^|\s)--help(?:\s|$)/.test(cmd)) return false;
    const code = resultExitCode(tc);
    return code === undefined || code === 0;
  });
  return { name, passed: used };
}

/** `declarative generate --overwrite` from the live catalog would drop the edit. */
async function checkSchemaKeptDescription(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'schema file still declares the description column';
  const result = await ctx.exec('cat supabase/schemas/*.sql 2>/dev/null');
  const hasDescription = /\bdescription\b/i.test(result.stdout);
  return {
    name,
    passed: result.ok && hasDescription,
    notes:
      result.ok && !hasDescription
        ? 'description not found in any schema file'
        : undefined,
  };
}

async function checkMigrationCapturesDescription(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'a new migration adds the description column';
  const files = await listNewMigrations(ctx);
  if (files.length === 0) {
    return { name, passed: false, notes: 'no migration beyond the seed' };
  }

  const contents = await ctx.exec(`cat ${files.join(' ')} 2>/dev/null`);
  const addsColumn =
    /\balter\s+table\b/i.test(contents.stdout) &&
    /\bdescription\b/i.test(contents.stdout);
  return {
    name,
    passed: contents.ok && addsColumn,
    notes: addsColumn
      ? undefined
      : `new migration(s) do not ALTER in description: ${files.join(', ')}`,
  };
}

async function checkDescriptionColumnLive(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'description column exists in the live database';
  try {
    const { rows } = await ctx.query(stripIndent`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'products' and column_name = 'description'
    `);
    return { name, passed: rows.length === 1 };
  } catch (error) {
    return {
      name,
      passed: false,
      notes: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Debug traces mixed into SQL are not an applicable migration. */
async function checkGeneratedSqlClean(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'generated migration SQL has no debug diagnostics';
  const files = await listNewMigrations(ctx);
  if (files.length === 0) {
    return { name, passed: false, notes: 'no generated migration to inspect' };
  }

  const contents = await ctx.exec(`cat ${files.join(' ')} 2>/dev/null`);
  const dirty = /dangling_edge|PGDELTA_DEBUG|[┌┐└┘│]/.test(contents.stdout);
  return {
    name,
    passed: contents.ok && !dirty,
    notes: dirty ? 'generated SQL contains debug/diagnostic output' : undefined,
  };
}

function shellCommand(tc: {
  command?: string;
  body?: Record<string, unknown>;
}) {
  const body = tc.body ?? {};
  return tc.command ?? (typeof body.command === 'string' ? body.command : '');
}

function resultExitCode(tc: { result?: unknown }): number | undefined {
  const res = tc.result;
  if (!res || typeof res !== 'object' || !('exit_code' in res))
    return undefined;
  const n = (res as { exit_code?: unknown }).exit_code;
  return typeof n === 'number' ? n : undefined;
}

async function listNewMigrations(
  ctx: LocalStackEvalContext
): Promise<string[]> {
  const listed = await ctx.exec('ls supabase/migrations/*.sql 2>/dev/null');
  if (!listed.ok) return [];
  return listed.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((f) => f.endsWith('.sql') && !f.endsWith(SEEDED_MIGRATION));
}
