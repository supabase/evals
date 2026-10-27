import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage } from '../lib/shell.js';
import { MIGRATIONS_DIR } from './fixtures.js';
import { psqlCommand, sqlFingerprint } from './sql.js';
import type { MigrationFile } from './workspace.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type HistoryRow = { version: string; statements: string[] | null };

export type HistoryProbe =
  | { ok: true; rows: HistoryRow[] }
  | { ok: false; notes: string };

export const HISTORY_CHECK =
  'the migration history matches the migration files';

const isHistoryRow = (row: unknown): row is HistoryRow => {
  if (typeof row !== 'object' || row === null) return false;
  const { version, statements } = row as Record<string, unknown>;
  return (
    typeof version === 'string' &&
    (statements === null ||
      (Array.isArray(statements) &&
        statements.every((statement) => typeof statement === 'string')))
  );
};

const READ_HISTORY = `-c "select coalesce(json_agg(json_build_object('version', version, 'statements', statements) order by version), '[]'::json) from supabase_migrations.schema_migrations"`;

/** Reads each recorded migration's version and statements from the local database. */
export async function readMigrationHistory(
  ctx: ExecContext,
  dbUrl: string
): Promise<HistoryProbe> {
  const unreadable = (reason: string): HistoryProbe => ({
    ok: false,
    notes: `could not read the migration history: ${reason}`,
  });
  try {
    const result = await ctx.exec(psqlCommand(dbUrl, READ_HISTORY));
    if (!result.ok) return unreadable(describeFailure(result));
    const rows: unknown = JSON.parse(result.stdout.trim());
    if (!Array.isArray(rows)) return unreadable('the history is not a list');
    if (!rows.every(isHistoryRow)) return unreadable('unexpected row shape');
    return { ok: true, rows };
  } catch (error) {
    return unreadable(errorMessage(error));
  }
}

/** Passes when every migration file has a history row with the same statements it holds now and no row lacks a file. */
export function checkHistoryMatchesFiles(
  migrations: readonly MigrationFile[],
  history: HistoryProbe
): CheckResult {
  const name = HISTORY_CHECK;
  if (!history.ok) return { name, passed: false, notes: history.notes };
  if (migrations.length === 0) {
    return {
      name,
      passed: false,
      notes: `no migration files in ${MIGRATIONS_DIR}`,
    };
  }
  const rows = new Map(history.rows.map((row) => [row.version, row]));
  const problems = migrations.flatMap((file) => {
    const row = rows.get(file.version);
    if (row === undefined)
      return [`${file.name} is not in the migration history`];
    const recorded = sqlFingerprint((row.statements ?? []).join('\n'));
    if (recorded === sqlFingerprint(file.sql)) return [];
    return [
      recorded === ''
        ? `${file.name} was recorded with no statements`
        : `${file.name} was recorded with different statements than the file now holds`,
    ];
  });
  const versions = new Set(migrations.map(({ version }) => version));
  for (const { version } of history.rows) {
    if (!versions.has(version)) {
      problems.push(`${version} is recorded but has no migration file`);
    }
  }
  return problems.length === 0
    ? {
        name,
        passed: true,
        notes: `${migrations.length} migration files recorded as they are now`,
      }
    : { name, passed: false, notes: problems.join('; ') };
}
