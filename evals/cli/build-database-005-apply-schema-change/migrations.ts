import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { maskSqlLiteralsAndComments } from '../lib/migrations.js';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';
import {
  DUE_DATE_COLUMN,
  SEEDED_MIGRATION_FILE,
  TASKS_TABLE,
} from './fixtures.js';

export type ColumnMigration = { version: string; file: string };
export type ColumnMigrationsProbe =
  | { ok: true; migrations: ColumnMigration[] }
  | { ok: false; notes: string };

export const NEW_MIGRATION_CHECK_NAME =
  'a new migration adds due_date to tasks';
export const MIGRATION_RECORDED_CHECK_NAME =
  'that migration is recorded in the local migration history';

const MIGRATION_FILENAME_RE = /^(\d+)_(.+)\.sql$/;

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `sql` has an `alter table` on `public.<table>` that adds `column`, ignoring comments and literals. */
export function migrationAddsColumn(
  sql: string,
  table: string,
  column: string
): boolean {
  const alterTable = new RegExp(
    `^\\s*alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:"?public"?\\.)?"?${escapeRegExp(table)}"?(?![\\w$"])`,
    'i'
  );
  const addColumn = new RegExp(
    `\\badd\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?"?${escapeRegExp(column)}"?(?![\\w$"])`,
    'i'
  );
  return maskSqlLiteralsAndComments(sql)
    .split(';')
    .some((statement) => {
      const alter = alterTable.exec(statement);
      return (
        alter !== null &&
        addColumn.test(statement.slice(alter.index + alter[0].length))
      );
    });
}

/** Migration files other than the seeded one that add `due_date` to `tasks`. */
export async function findDueDateMigrations(
  ctx: Pick<LocalStackEvalContext, 'exec' | 'folderExists'>
): Promise<ColumnMigrationsProbe> {
  try {
    if (!(await ctx.folderExists('supabase/migrations'))) {
      return { ok: false, notes: 'supabase/migrations does not exist' };
    }
    const listing = await ctx.exec('ls supabase/migrations 2>/dev/null | sort');
    const files = listing.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!listing.ok || files.length === 0) {
      return {
        ok: false,
        notes: 'no migration files found under supabase/migrations',
      };
    }
    const migrations: ColumnMigration[] = [];
    let seededAddsColumn = false;
    for (const file of files) {
      const match = file.match(MIGRATION_FILENAME_RE);
      if (!match) continue;
      const result = await ctx.exec(
        `cat ${shellQuote(`supabase/migrations/${file}`)}`
      );
      if (!result.ok) continue;
      if (!migrationAddsColumn(result.stdout, TASKS_TABLE, DUE_DATE_COLUMN)) {
        continue;
      }
      if (file === SEEDED_MIGRATION_FILE) seededAddsColumn = true;
      else migrations.push({ version: match[1], file });
    }
    if (migrations.length > 0) return { ok: true, migrations };
    return {
      ok: false,
      notes: seededAddsColumn
        ? `only the seeded migration ${SEEDED_MIGRATION_FILE} adds ${DUE_DATE_COLUMN}; no new migration does`
        : `no new migration adds ${DUE_DATE_COLUMN} to ${TASKS_TABLE}`,
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

const describeMigrations = (migrations: readonly ColumnMigration[]) =>
  migrations
    .map(({ file, version }) => `${file} (version ${version})`)
    .join(', ');

export function checkNewMigrationAddsDueDate(
  probe: ColumnMigrationsProbe
): CheckResult {
  const name = NEW_MIGRATION_CHECK_NAME;
  return probe.ok
    ? { name, passed: true, notes: describeMigrations(probe.migrations) }
    : { name, passed: false, notes: probe.notes };
}

/** Passes when a migration that adds the column is in the CLI's migration history, so the change was applied through the CLI rather than by hand. */
export async function checkMigrationRecorded(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stack: StackProbe,
  probe: ColumnMigrationsProbe
): Promise<CheckResult> {
  const name = MIGRATION_RECORDED_CHECK_NAME;
  if (!stack.ok) return { name, passed: false, notes: stack.notes };
  if (!probe.ok) return { name, passed: false, notes: probe.notes };
  try {
    const versions = probe.migrations.map(({ version }) => `'${version}'`);
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc "select version from supabase_migrations.schema_migrations where version in (${versions.join(', ')})"`
    );
    if (!result.ok) {
      return { name, passed: false, notes: describeFailure(result) };
    }
    const recorded = new Set(
      result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    );
    const found = probe.migrations.filter(({ version }) =>
      recorded.has(version)
    );
    if (found.length === 0) {
      const missing = probe.migrations.map(({ version }) => version);
      return {
        name,
        passed: false,
        notes: `version(s) ${missing.join(', ')} not in supabase_migrations.schema_migrations (the column was applied outside the CLI's migration history)`,
      };
    }
    return {
      name,
      passed: true,
      notes: `${describeMigrations(found)} ${found.length === 1 ? 'is' : 'are'} in supabase_migrations.schema_migrations`,
    };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}
