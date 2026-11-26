import { stripIndent } from 'common-tags';
import type {
  CheckResult,
  LocalStackEvalContext,
  LocalStackScorer,
} from '@supabase-evals/core';

const scorer: LocalStackScorer = async (ctx) => {
  const checks: CheckResult[] = [
    checkMigrationGeneratedByCli(ctx),
    await checkSchemaFileUpdated(ctx),
    await checkNewMigrationGenerated(ctx),
    await checkDescriptionColumnLive(ctx),
  ];

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
};

export default scorer;

/**
 * Commands that generate a migration from the schema files. The declarative
 * schemas guide uses `supabase db schema declarative sync` on the `pg-delta`
 * engine, and `supabase db diff` on the legacy `migra` engine.
 */
const MIGRATION_GENERATOR_PATTERN =
  /supabase\s+db\s+(?:diff|schema\s+declarative\s+sync)\b/;

/** Checks that the agent generated the migration with the CLI rather than hand-writing it. */
function checkMigrationGeneratedByCli(ctx: LocalStackEvalContext): CheckResult {
  const name =
    'migration generated with supabase db schema declarative sync or db diff';
  const used = ctx.toolCalls.some((tc) =>
    MIGRATION_GENERATOR_PATTERN.test(tc.command ?? '')
  );
  return { name, passed: used };
}

/** Checks that the schema file was updated to reflect the new column. */
async function checkSchemaFileUpdated(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'schema file updated to include description column';
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

/** Checks that a new migration file was created on top of the seeded one. */
async function checkNewMigrationGenerated(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'a new migration was generated for the change';
  const result = await ctx.exec(
    'ls supabase/migrations/*.sql 2>/dev/null | wc -l'
  );
  const count = parseInt(result.stdout.trim(), 10);
  return {
    name,
    passed: result.ok && count >= 2,
    notes:
      result.ok && count >= 2
        ? undefined
        : `found ${isNaN(count) ? 0 : count} migration file(s)`,
  };
}

/** Checks that the migration was applied and the column is actually in the database. */
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
