import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { maskSqlLiteralsAndComments } from '../lib/migrations.js';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';
import {
  DUE_DATE_COLUMN,
  SEEDED_MIGRATION_FILE,
  SEEDED_MIGRATION_VERSION,
  TASKS_TABLE,
} from './fixtures.js';

export type ColumnMigration = { version: string; file: string };
export type ColumnMigrationsProbe =
  | {
      ok: true;
      migrations: ColumnMigration[];
      addsNeededShape: boolean;
      notes: string;
    }
  | { ok: false; notes: string };
export type RecordedMigrationsProbe =
  | {
      ok: true;
      recorded: ColumnMigration[];
      missing: ColumnMigration[];
      mismatched: ColumnMigration[];
    }
  | { ok: false; notes: string };

export const NEW_MIGRATION_CHECK_NAME =
  'a new migration adds due_date to tasks as a nullable date or timestamp';
export const MIGRATION_RECORDED_CHECK_NAME =
  'that migration is recorded in the local migration history';

const MIGRATION_FILENAME_RE = /^(\d+)_(.+)\.sql$/;
const ACCEPTED_TYPE_RE =
  /^(?:"?pg_catalog"?\s*\.\s*)?"?(?:date|timestamptz|timestamp)"?(?:\s*\(\s*\d+\s*\))?(?:\s+(?:with|without)\s+time\s+zone)?(?![\w$"])/i;
const ARRAY_SUFFIX_RE = /^\s*(?:\[|array(?![\w$"]))/i;
const NOT_NULL_RE = /\bnot\s+null\b/i;
const HISTORY_ROW_RE = /^(\d+)\|((?:[0-9a-f]{2})*)$/i;
const GENERATED_RE = /\bgenerated\b/i;
const NO_NEW_MIGRATION_NOTE = `no new migration adds ${DUE_DATE_COLUMN} to ${TASKS_TABLE}`;
const SEEDED_ONLY_NOTE = `only the seeded migration ${SEEDED_MIGRATION_FILE} adds ${DUE_DATE_COLUMN}; no new migration does`;

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

const tableNamePattern = (table: string) =>
  `(?:"?public"?\\s*\\.\\s*)?"?${escapeRegExp(table)}"?(?![\\w$"])`;

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type ColumnAction =
  | { kind: 'add'; clause: string; ifNotExists: boolean }
  | { kind: 'type'; type: string }
  | { kind: 'nullability'; nullable: boolean }
  | { kind: 'drop'; ifExists: boolean }
  | { kind: 'rename' }
  | { kind: 'drop-table' };

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

/** The text before the parenthesis that closes the one opened just before `text`. */
function parenthesisedBody(text: string): string {
  let depth = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')' && --depth === 0) return text.slice(0, i);
  }
  return text;
}

/** Whether `sql` mentions `table`, bare or qualified with `public`, outside comments and literals. */
function referencesTable(sql: string, table: string): boolean {
  return new RegExp(`(?<![\\w$".])${tableNamePattern(table)}`, 'i').test(
    maskSqlLiteralsAndComments(sql)
  );
}

/** The actions that change `column`, or drop `table`, in `public.<table>` statements, in order, ignoring comments and literals; `createTable` also reads the column's definition in a `create table`. */
function columnActions(
  sql: string,
  table: string,
  column: string,
  { createTable = false }: { createTable?: boolean } = {}
): ColumnAction[] {
  const columnName = `"?${escapeRegExp(column)}"?(?![\\w$"])`;
  const alterColumn = `^\\s*alter\\s+(?:column\\s+)?${columnName}`;
  const tableName = tableNamePattern(table);
  const alterTable = new RegExp(
    `^\\s*alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${tableName}`,
    'i'
  );
  const createTableStatement = new RegExp(
    `^\\s*create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${tableName}\\s*\\(`,
    'i'
  );
  const columnDefinition = new RegExp(`^\\s*${columnName}`, 'i');
  const dropTable = /^\s*drop\s+table\s+(?:if\s+exists\s+)?/i;
  const tableItem = new RegExp(`^\\s*${tableName}`, 'i');
  const addColumn = new RegExp(
    `^\\s*add\\s+(?:column\\s+)?(if\\s+not\\s+exists\\s+)?${columnName}`,
    'i'
  );
  const alterType = new RegExp(
    `${alterColumn}\\s+(?:set\\s+data\\s+)?type\\s+`,
    'i'
  );
  const alterNullability = new RegExp(
    `${alterColumn}\\s+(drop|set)\\s+not\\s+null(?![\\w$"])`,
    'i'
  );
  const dropColumn = new RegExp(
    `^\\s*drop\\s+(?:column\\s+)?(if\\s+exists\\s+)?${columnName}`,
    'i'
  );
  const renameColumn = new RegExp(
    `^\\s*rename\\s+(?:column\\s+)?${columnName}\\s+to(?![\\w$"])`,
    'i'
  );

  const parseAction = (action: string): ColumnAction[] => {
    const added = addColumn.exec(action);
    if (added !== null) {
      return [
        {
          kind: 'add',
          clause: action.slice(added[0].length).trim(),
          ifNotExists: added[1] !== undefined,
        },
      ];
    }
    const typed = alterType.exec(action);
    if (typed !== null) {
      return [{ kind: 'type', type: action.slice(typed[0].length).trim() }];
    }
    const nullability = alterNullability.exec(action);
    if (nullability !== null) {
      return [
        {
          kind: 'nullability',
          nullable: nullability[1].toLowerCase() === 'drop',
        },
      ];
    }
    const dropped = dropColumn.exec(action);
    if (dropped !== null) {
      return [{ kind: 'drop', ifExists: dropped[1] !== undefined }];
    }
    return renameColumn.test(action) ? [{ kind: 'rename' }] : [];
  };

  return maskSqlLiteralsAndComments(sql)
    .split(';')
    .flatMap((statement): ColumnAction[] => {
      const alter = alterTable.exec(statement);
      if (alter !== null) {
        return topLevelActions(
          statement.slice(alter.index + alter[0].length)
        ).flatMap(parseAction);
      }
      const create = createTable ? createTableStatement.exec(statement) : null;
      if (create !== null) {
        return topLevelActions(
          parenthesisedBody(statement.slice(create[0].length))
        ).flatMap((item): ColumnAction[] => {
          const definition = columnDefinition.exec(item);
          return definition === null
            ? []
            : [
                {
                  kind: 'add',
                  clause: item.slice(definition[0].length).trim(),
                  ifNotExists: false,
                },
              ];
        });
      }
      const drop = dropTable.exec(statement);
      if (
        drop !== null &&
        topLevelActions(statement.slice(drop[0].length)).some((item) =>
          tableItem.test(item)
        )
      ) {
        return [{ kind: 'drop-table' }];
      }
      return [];
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

function isAcceptedType(clause: string): boolean {
  const match = ACCEPTED_TYPE_RE.exec(clause);
  return match !== null && !ARRAY_SUFFIX_RE.test(clause.slice(match[0].length));
}

type ColumnState =
  | { kind: 'missing'; note?: string }
  | {
      kind: 'exists';
      typeClause: string;
      nullable: boolean;
      addedBy: string;
      addedAs: string;
    }
  | { kind: 'broken'; note: string };

function applyAction(
  state: ColumnState,
  action: ColumnAction,
  file: string
): ColumnState {
  if (state.kind === 'broken') return state;
  if (action.kind === 'drop-table') {
    return state.kind === 'exists'
      ? { kind: 'missing', note: `${file} drops ${TASKS_TABLE}` }
      : state;
  }
  if (state.kind === 'missing') {
    if (action.kind === 'add') {
      return {
        kind: 'exists',
        typeClause: action.clause,
        nullable: !NOT_NULL_RE.test(blankNested(action.clause)),
        addedBy: file,
        addedAs: action.clause,
      };
    }
    return action.kind === 'drop' && action.ifExists
      ? state
      : {
          kind: 'broken',
          note: `${file} alters ${DUE_DATE_COLUMN} before any migration adds it, so a reset fails`,
        };
  }
  switch (action.kind) {
    case 'add':
      return action.ifNotExists
        ? state
        : {
            kind: 'broken',
            note: `${file} adds ${DUE_DATE_COLUMN} again without if not exists, so a reset fails`,
          };
    case 'type':
      return { ...state, typeClause: action.type };
    case 'nullability':
      return { ...state, nullable: action.nullable };
    case 'drop':
      return { kind: 'missing', note: `${file} drops ${DUE_DATE_COLUMN}` };
    case 'rename':
      return { kind: 'missing', note: `${file} renames ${DUE_DATE_COLUMN}` };
  }
}

function describeOutcome(
  state: ColumnState,
  migrations: readonly ColumnMigration[]
): { addsNeededShape: boolean; notes: string } {
  if (state.kind === 'broken') {
    return { addsNeededShape: false, notes: state.note };
  }
  if (state.kind === 'missing') {
    return {
      addsNeededShape: false,
      notes: state.note ?? NO_NEW_MIGRATION_NOTE,
    };
  }
  const seededOnly = state.addedBy === SEEDED_MIGRATION_FILE;
  if (seededOnly && migrations.length === 0) {
    return { addsNeededShape: false, notes: SEEDED_ONLY_NOTE };
  }
  const files = migrations.map(({ file }) => file).join(', ');
  const shape = squash(state.typeClause);
  if (!isAcceptedType(state.typeClause)) {
    return {
      addsNeededShape: false,
      notes: `after ${files}, ${DUE_DATE_COLUMN} is ${shape}, not a date or timestamp`,
    };
  }
  if (GENERATED_RE.test(blankNested(state.typeClause))) {
    return {
      addsNeededShape: false,
      notes: `after ${files}, ${DUE_DATE_COLUMN} is generated (${shape}), so the app can't write it`,
    };
  }
  if (!state.nullable) {
    return {
      addsNeededShape: false,
      notes: `after ${files}, ${DUE_DATE_COLUMN} is not nullable (${shape})`,
    };
  }
  if (seededOnly) return { addsNeededShape: false, notes: SEEDED_ONLY_NOTE };
  const later = migrations
    .slice(migrations.findIndex(({ file }) => file === state.addedBy) + 1)
    .map(({ file }) => file);
  return {
    addsNeededShape: true,
    notes: `${state.addedBy} adds ${DUE_DATE_COLUMN} as ${squash(state.addedAs)}${later.length > 0 ? `; later files touching it: ${later.join(', ')}` : ''}`,
  };
}

type ScannedMigration = ColumnMigration & { actions: ColumnAction[] };

/** Replays the seeded migration and the new ones in version order and reports whether `tasks.due_date` ends as a nullable date or timestamp. */
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
    const preSeeded: ScannedMigration[] = [];
    const strays: string[] = [];
    let seededActions: ColumnAction[] = [];
    for (const file of files) {
      const match = file.match(MIGRATION_FILENAME_RE);
      if (!match) continue;
      const result = await ctx.exec(
        `cat ${shellQuote(`supabase/migrations/${file}`)}`
      );
      if (!result.ok) continue;
      const isSeeded = file === SEEDED_MIGRATION_FILE;
      const actions = columnActions(
        result.stdout,
        TASKS_TABLE,
        DUE_DATE_COLUMN,
        { createTable: isSeeded }
      );
      if (isSeeded) {
        seededActions = actions;
      } else if (match[1] <= SEEDED_MIGRATION_VERSION) {
        if (actions.length > 0) {
          preSeeded.push({ version: match[1], file, actions });
        }
        if (referencesTable(result.stdout, TASKS_TABLE)) strays.push(file);
      } else if (actions.length > 0) {
        scanned.push({ version: match[1], file, actions });
      }
    }
    const byVersion = (a: ScannedMigration, b: ScannedMigration) =>
      compareText(a.version, b.version) || compareText(a.file, b.file);
    scanned.sort(byVersion);
    preSeeded.sort(byVersion);

    let state: ColumnState = { kind: 'missing' };
    for (const action of seededActions) {
      state = applyAction(state, action, SEEDED_MIGRATION_FILE);
    }
    for (const { file, actions } of scanned) {
      for (const action of actions) state = applyAction(state, action, file);
    }

    const toMigration = ({ version, file }: ScannedMigration) => ({
      version,
      file,
    });
    const migrations = [...preSeeded, ...scanned].map(toMigration);
    if (strays.length > 0) {
      return {
        ok: true,
        migrations,
        addsNeededShape: false,
        notes: strays
          .map(
            (file) =>
              `${file} sorts at or before ${SEEDED_MIGRATION_VERSION}, so a reset applies it before ${TASKS_TABLE} exists`
          )
          .join('; '),
      };
    }
    return {
      ok: true,
      migrations,
      ...describeOutcome(state, scanned.map(toMigration)),
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
  const touched = describeMigrations(probe.migrations);
  return {
    name,
    passed: probe.addsNeededShape,
    notes: touched === '' ? probe.notes : `${touched}; ${probe.notes}`,
  };
}

export const describeMissingVersions = (missing: readonly ColumnMigration[]) =>
  `version(s) ${missing.map(({ version }) => version).join(', ')} not in supabase_migrations.schema_migrations`;

export const describeMismatchedVersions = (
  mismatched: readonly ColumnMigration[]
) =>
  `version(s) ${mismatched.map(({ version }) => version).join(', ')} recorded with different ${DUE_DATE_COLUMN} statements than the file now holds, so the file changed after it was applied`;

const actionSignature = (sql: string) =>
  columnActions(sql, TASKS_TABLE, DUE_DATE_COLUMN)
    .map((action) =>
      JSON.stringify(action, (_key, value) =>
        typeof value === 'string' ? squash(value).toLowerCase() : value
      )
    )
    .join('\n');

/** Reads which of the migrations that touch the column are in the CLI's migration history with the statements the files hold now. */
export async function readRecordedMigrations(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stack: StackProbe,
  probe: ColumnMigrationsProbe
): Promise<RecordedMigrationsProbe> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  if (!probe.ok) return { ok: false, notes: probe.notes };
  const { migrations } = probe;
  if (migrations.length === 0) {
    return { ok: false, notes: `no new migration touches ${DUE_DATE_COLUMN}` };
  }
  try {
    const versions = migrations.map(({ version }) => `'${version}'`);
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc "select version || '|' || encode(convert_to(coalesce(array_to_string(statements, ';' || chr(10)), ''), 'UTF8'), 'hex') from supabase_migrations.schema_migrations where version in (${versions.join(', ')})"`
    );
    if (!result.ok) return { ok: false, notes: describeFailure(result) };
    const history = new Map<string, string>();
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const row = HISTORY_ROW_RE.exec(trimmed);
      if (row === null) {
        return {
          ok: false,
          notes: `unrecognised migration history row: ${trimmed.slice(0, 120)}`,
        };
      }
      history.set(row[1], Buffer.from(row[2], 'hex').toString('utf8'));
    }

    const recorded: ColumnMigration[] = [];
    const missing: ColumnMigration[] = [];
    const mismatched: ColumnMigration[] = [];
    for (const migration of migrations) {
      const statements = history.get(migration.version);
      if (statements === undefined) {
        missing.push(migration);
        continue;
      }
      const file = await ctx.exec(
        `cat ${shellQuote(`supabase/migrations/${migration.file}`)}`
      );
      if (!file.ok) return { ok: false, notes: describeFailure(file) };
      const matches =
        actionSignature(statements) === actionSignature(file.stdout);
      (matches ? recorded : mismatched).push(migration);
    }
    return { ok: true, recorded, missing, mismatched };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

/** Passes when every migration that touches the column is recorded in the CLI's migration history with the due_date statements the file holds now. */
export function checkMigrationRecorded(
  probe: RecordedMigrationsProbe
): CheckResult {
  const name = MIGRATION_RECORDED_CHECK_NAME;
  if (!probe.ok) return { name, passed: false, notes: probe.notes };
  const problems = [
    ...(probe.missing.length > 0
      ? [describeMissingVersions(probe.missing)]
      : []),
    ...(probe.mismatched.length > 0
      ? [describeMismatchedVersions(probe.mismatched)]
      : []),
  ];
  if (problems.length > 0 || probe.recorded.length === 0) {
    return { name, passed: false, notes: problems.join('; ') };
  }
  return {
    name,
    passed: true,
    notes: `${describeMigrations(probe.recorded)} ${probe.recorded.length === 1 ? 'is' : 'are'} in supabase_migrations.schema_migrations`,
  };
}
