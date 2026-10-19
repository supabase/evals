import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { maskSqlLiteralsAndComments } from '../lib/migrations.js';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';
import {
  DUE_DATE_COLUMN,
  SEEDED_MIGRATION_FILE,
  TASKS_TABLE,
} from './fixtures.js';

export type ColumnMigration = {
  version: string;
  file: string;
  shapeChangedBy?: string;
};
export type ColumnMigrationsProbe =
  | { ok: true; migrations: ColumnMigration[] }
  | { ok: false; notes: string };
export type RecordedMigrationsProbe =
  | { ok: true; recorded: ColumnMigration[]; missing: ColumnMigration[] }
  | { ok: false; notes: string };

export const NEW_MIGRATION_CHECK_NAME =
  'a new migration adds due_date to tasks as a nullable date or timestamp';
export const MIGRATION_RECORDED_CHECK_NAME =
  'that migration is recorded in the local migration history';

const MIGRATION_FILENAME_RE = /^(\d+)_(.+)\.sql$/;
const ACCEPTED_TYPE_RE =
  /^(?:pg_catalog\.)?"?(?:date|timestamptz|timestamp)"?(?:\s*\(\s*\d+\s*\))?(?:\s+(?:with|without)\s+time\s+zone)?(?![\w$"])/i;
const NOT_NULL_RE = /\bnot\s+null\b/i;

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type ColumnAction = { kind: 'add'; clause: string } | { kind: 'alter' };

/** `text` with everything inside parentheses, and the parentheses themselves, blanked. */
function blankNested(text: string): string {
  let depth = 0;
  let blanked = '';
  for (const char of text) {
    if (char === '(') depth++;
    blanked += depth > 0 ? ' ' : char;
    if (char === ')' && depth > 0) depth--;
  }
  return blanked;
}

function topLevelActions(text: string): string[] {
  const flat = blankNested(text);
  const actions: string[] = [];
  let start = 0;
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] === ',') {
      actions.push(text.slice(start, i));
      start = i + 1;
    }
  }
  actions.push(text.slice(start));
  return actions;
}

/** The `add` and `alter` actions on `column` in `alter table public.<table>` statements, in order, ignoring comments and literals. */
function columnActions(
  sql: string,
  table: string,
  column: string
): ColumnAction[] {
  const columnName = `"?${escapeRegExp(column)}"?(?![\\w$"])`;
  const alterTable = new RegExp(
    `^\\s*alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:"?public"?\\.)?"?${escapeRegExp(table)}"?(?![\\w$"])`,
    'i'
  );
  const addColumn = new RegExp(
    `^\\s*add\\s+(?:column\\s+)?(?:if\\s+not\\s+exists\\s+)?${columnName}`,
    'i'
  );
  const alterColumn = new RegExp(
    `^\\s*alter\\s+(?:column\\s+)?${columnName}`,
    'i'
  );
  return maskSqlLiteralsAndComments(sql)
    .split(';')
    .flatMap((statement): ColumnAction[] => {
      const alter = alterTable.exec(statement);
      if (alter === null) return [];
      return topLevelActions(
        statement.slice(alter.index + alter[0].length)
      ).flatMap((action): ColumnAction[] => {
        const added = addColumn.exec(action);
        if (added !== null) {
          return [
            { kind: 'add', clause: action.slice(added[0].length).trim() },
          ];
        }
        return alterColumn.test(action) ? [{ kind: 'alter' }] : [];
      });
    });
}

/** Whether `sql` has an `alter table` on `public.<table>` that adds `column`, ignoring comments and literals. */
export function migrationAddsColumn(
  sql: string,
  table: string,
  column: string
): boolean {
  return columnActions(sql, table, column).some(({ kind }) => kind === 'add');
}

const isNullableDateOrTimestamp = (clause: string) =>
  ACCEPTED_TYPE_RE.test(clause) && !NOT_NULL_RE.test(blankNested(clause));

type ScannedMigration = ColumnMigration & { actions: ColumnAction[] };

/** Migration files other than the seeded one that add `due_date` to `tasks` as a nullable date or timestamp. */
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
    const scanned: ScannedMigration[] = [];
    let seededAddsColumn = false;
    for (const file of files) {
      const match = file.match(MIGRATION_FILENAME_RE);
      if (!match) continue;
      const result = await ctx.exec(
        `cat ${shellQuote(`supabase/migrations/${file}`)}`
      );
      if (!result.ok) continue;
      const actions = columnActions(
        result.stdout,
        TASKS_TABLE,
        DUE_DATE_COLUMN
      );
      if (file === SEEDED_MIGRATION_FILE) {
        seededAddsColumn = actions.some(({ kind }) => kind === 'add');
      } else {
        scanned.push({ version: match[1], file, actions });
      }
    }

    const migrations: ColumnMigration[] = [];
    const wrongShape: string[] = [];
    scanned.forEach(({ version, file, actions }, index) => {
      const adds = actions.filter((action) => action.kind === 'add');
      if (adds.length === 0) return;
      if (adds.some(({ clause }) => isNullableDateOrTimestamp(clause))) {
        migrations.push({ version, file });
        return;
      }
      const reshaper = scanned
        .slice(index + 1)
        .find((later) => later.actions.some(({ kind }) => kind === 'alter'));
      if (reshaper !== undefined) {
        migrations.push({ version, file, shapeChangedBy: reshaper.file });
        return;
      }
      wrongShape.push(
        `${file} adds ${DUE_DATE_COLUMN} as ${adds[0].clause.replace(/\s+/g, ' ')}, not a nullable date or timestamp`
      );
    });

    if (migrations.length > 0) return { ok: true, migrations };
    if (wrongShape.length > 0)
      return { ok: false, notes: wrongShape.join('; ') };
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

export const describeMigrations = (migrations: readonly ColumnMigration[]) =>
  migrations
    .map(({ file, version }) => `${file} (version ${version})`)
    .join(', ');

export function checkNewMigrationAddsDueDate(
  probe: ColumnMigrationsProbe
): CheckResult {
  const name = NEW_MIGRATION_CHECK_NAME;
  if (!probe.ok) return { name, passed: false, notes: probe.notes };
  const reshapers = new Set(
    probe.migrations.flatMap(({ shapeChangedBy }) => shapeChangedBy ?? [])
  );
  const reshaped =
    reshapers.size > 0
      ? `; shape changed by ${[...reshapers].join(', ')}; the database check covers the final shape`
      : '';
  return {
    name,
    passed: true,
    notes: `${describeMigrations(probe.migrations)}${reshaped}`,
  };
}

export const describeMissingVersions = (missing: readonly ColumnMigration[]) =>
  `version(s) ${missing.map(({ version }) => version).join(', ')} not in supabase_migrations.schema_migrations`;

/** Reads which of the matching migrations are in the CLI's migration history. */
export async function readRecordedMigrations(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stack: StackProbe,
  migrations: ColumnMigrationsProbe
): Promise<RecordedMigrationsProbe> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  if (!migrations.ok) return { ok: false, notes: migrations.notes };
  try {
    const versions = migrations.migrations.map(({ version }) => `'${version}'`);
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc "select version from supabase_migrations.schema_migrations where version in (${versions.join(', ')})"`
    );
    if (!result.ok) return { ok: false, notes: describeFailure(result) };
    const rows = new Set(
      result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    );
    return {
      ok: true,
      recorded: migrations.migrations.filter(({ version }) =>
        rows.has(version)
      ),
      missing: migrations.migrations.filter(
        ({ version }) => !rows.has(version)
      ),
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

/** Passes when a migration that adds the column is recorded in the CLI's migration history. */
export function checkMigrationRecorded(
  probe: RecordedMigrationsProbe
): CheckResult {
  const name = MIGRATION_RECORDED_CHECK_NAME;
  if (!probe.ok) return { name, passed: false, notes: probe.notes };
  if (probe.recorded.length === 0) {
    return {
      name,
      passed: false,
      notes: describeMissingVersions(probe.missing),
    };
  }
  return {
    name,
    passed: true,
    notes: `${describeMigrations(probe.recorded)} ${probe.recorded.length === 1 ? 'is' : 'are'} in supabase_migrations.schema_migrations`,
  };
}
