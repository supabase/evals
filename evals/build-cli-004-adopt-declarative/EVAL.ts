import { stripIndent } from 'common-tags';
import type {
  CheckResult,
  LocalStackEvalContext,
  LocalStackScorer,
} from '@supabase-evals/core';

const SEEDED_MIGRATION = '20260101000000_create_products.sql';

const scorer: LocalStackScorer = async (ctx) => {
  const checks: CheckResult[] = [
    checkAdoptCommandUsed(ctx),
    await checkExportTreePresent(ctx),
    await checkNotesDeclared(ctx),
    checkSyncUsed(ctx),
    await checkNotesMigrationGenerated(ctx),
    await checkNotesLive(ctx),
    await checkProductsStillLive(ctx),
    await checkNoManagedSchemaCreates(ctx),
  ];

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
};

export default scorer;

function checkAdoptCommandUsed(ctx: LocalStackEvalContext): CheckResult {
  const name =
    'declarative export used (db pull --declarative or declarative generate)';
  const used = ctx.toolCalls.some((tc) => {
    const cmd = shellCommand(tc);
    if (tc.error || /(?:^|\s)--help(?:\s|$)/.test(cmd)) return false;
    const code = resultExitCode(tc);
    if (code !== undefined && code !== 0) return false;
    const pullDeclarative =
      /supabase\s+db\s+pull\b/.test(cmd) && /--declarative/.test(cmd);
    const generate = /supabase\s+db\s+schema\s+declarative\s+generate/.test(
      cmd
    );
    return pullDeclarative || generate;
  });
  return { name, passed: used };
}

async function checkExportTreePresent(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'declarative schema tree and export manifest exist';
  const tree = await ctx.exec(
    "find supabase/schemas -name '*.sql' 2>/dev/null"
  );
  const hasManifest = await ctx.fileExists(
    'supabase/schemas/.pgdelta-export.json'
  );
  const hasSql = /\.sql\b/.test(tree.stdout);
  const passed = tree.ok && hasSql && hasManifest;
  return {
    name,
    passed,
    notes: passed ? undefined : `sql files=${hasSql} manifest=${hasManifest}`,
  };
}

async function checkNotesDeclared(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'notes table is declared in schema files';
  const result = await ctx.exec(
    "find supabase/schemas -name '*.sql' -exec cat {} +"
  );
  const declared =
    /create\s+table\s+(if\s+not\s+exists\s+)?(["']?public["']?\.)?["']?notes\b/i.test(
      result.stdout
    );
  return {
    name,
    passed: result.ok && declared,
    notes: declared ? undefined : 'notes not found in supabase/schemas',
  };
}

function checkSyncUsed(ctx: LocalStackEvalContext): CheckResult {
  const name = 'supabase db schema declarative sync used for the notes change';
  const used = ctx.toolCalls.some((tc) => {
    const cmd = shellCommand(tc);
    if (!/supabase\s+db\s+schema\s+declarative\s+sync/.test(cmd)) return false;
    if (tc.error || /(?:^|\s)--help(?:\s|$)/.test(cmd)) return false;
    const code = resultExitCode(tc);
    return code === undefined || code === 0;
  });
  return { name, passed: used };
}

async function checkNotesMigrationGenerated(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'a new migration creates the notes table';
  const files = await listNewMigrations(ctx);
  if (files.length === 0) {
    return { name, passed: false, notes: 'no migration beyond the seed' };
  }
  const contents = await ctx.exec(`cat ${files.join(' ')} 2>/dev/null`);
  const creates =
    /\bnotes\b/i.test(contents.stdout) &&
    /\bcreate\s+table\b/i.test(contents.stdout);
  return {
    name,
    passed: contents.ok && creates,
    notes: creates
      ? undefined
      : `new migration(s) do not create notes: ${files.join(', ')}`,
  };
}

async function checkNotesLive(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'notes table exists in the live database';
  try {
    const { rows } = await ctx.query(stripIndent`
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'notes'
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

async function checkProductsStillLive(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'products table still exists';
  try {
    const { rows } = await ctx.query(stripIndent`
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'products'
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

async function checkNoManagedSchemaCreates(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'generated SQL does not CREATE SCHEMA auth or storage';
  const files = await listNewMigrations(ctx);
  if (files.length === 0) {
    return { name, passed: false, notes: 'no generated migration to inspect' };
  }
  const migrations = await ctx.exec(`cat ${files.join(' ')} 2>/dev/null`);
  const schemas = await ctx.exec(
    "find supabase/schemas -name '*.sql' -exec cat {} +"
  );
  const sql = `${migrations.stdout}\n${schemas.stdout}`;
  const dirty =
    /create\s+schema\s+(if\s+not\s+exists\s+)?["']?(auth|storage)\b/i.test(
      sql
    ) || /dangling_edge|PGDELTA_DEBUG|[┌┐└┘│]/.test(sql);
  return {
    name,
    passed: migrations.ok && !dirty,
    notes: dirty
      ? 'generated SQL creates a managed schema or contains debug output'
      : undefined,
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
