import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { queryDatabase } from './psql.js';
import {
  describeFailure,
  errorMessage,
  inProjectDir,
  shellQuote,
} from './shell.js';
import type { StackProbe } from './stack.js';

// Filename timestamp isn't guaranteed to be exactly 14 digits in every agent
// run; tolerant on width, but still sorts correctly (lexical sort on a
// numeric-only prefix == chronological, same as the seeded 14-digit case).
const MIGRATION_FILENAME_RE = /^(\d+)_(.+)\.sql$/;

const HISTORY_ROW_RE = /^(\d+)\|((?:[0-9a-f]{2})*)$/i;

const DOLLAR_TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Strips `-- …` line comments and `/* … *\/` block comments (which Postgres
 * nests) from `sql`, without touching `--`/`/*` that appear inside a
 * single-quoted string, a double-quoted identifier, or a dollar-quoted body
 * (`$$…$$`/`$tag$…$tag$`) — those spans are copied through verbatim.
 */
export function stripSqlComments(sql: string): string {
  return scanSql(sql, false);
}

/**
 * Like `stripSqlComments`, but also empties single-quoted literals and
 * dollar-quoted bodies so SQL text inside them can't match a DDL pattern.
 * Double-quoted identifiers are kept.
 */
export function maskSqlLiteralsAndComments(sql: string): string {
  return scanSql(sql, true);
}

function scanSql(sql: string, maskLiterals: boolean): string {
  let result = '';
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) {
        i = sql.length;
      } else {
        result += '\n';
        i = nl + 1;
      }
      continue;
    }
    if (two === '/*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        const pair = sql.slice(i, i + 2);
        if (pair === '/*') {
          depth++;
          i += 2;
        } else if (pair === '*/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      result += ' ';
      continue;
    }

    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const next = consumeQuoted(
        sql,
        i,
        ch,
        ch === "'" && isEscapeString(sql, i)
      );
      result += maskLiterals && ch === "'" ? "''" : sql.slice(i, next);
      i = next;
      continue;
    }
    if (ch === '$') {
      const tagMatch = sql.slice(i).match(DOLLAR_TAG_RE);
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? sql.length : close + tag.length;
        result += maskLiterals ? tag + tag : sql.slice(i, end);
        i = end;
        continue;
      }
    }

    result += ch;
    i++;
  }
  return result;
}

/** Whether the `'` at `quoteIndex` opens an `E'…'` escape string, where backslash escapes the next character. */
function isEscapeString(sql: string, quoteIndex: number): boolean {
  return (
    /[Ee]/.test(sql[quoteIndex - 1] ?? '') &&
    !/[\w$]/.test(sql[quoteIndex - 2] ?? '')
  );
}

/** Returns the index just past the `quote`-delimited literal opening at `start`, honouring doubled-quote escapes. */
function consumeQuoted(
  sql: string,
  start: number,
  quote: string,
  backslashEscapes: boolean
): number {
  let i = start + 1;
  while (i < sql.length) {
    if (backslashEscapes && sql[i] === '\\') {
      i += 2;
      continue;
    }
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return i;
}

function createsTablePattern(table: string): RegExp {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `create\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?("?public"?\\.)?"?${escaped}"?(?![\\w$"])`,
    'i'
  );
}

/** Whether `sql` creates `public.<table>` with `create [unlogged] table`, ignoring comments and literals. */
export function migrationCreatesTable(sql: string, table: string): boolean {
  return createsTablePattern(table).test(maskSqlLiteralsAndComments(sql));
}

export type TableMigrationProbe =
  | { ok: true; version: string; file: string }
  | { ok: false; notes: string };

/**
 * Finds the migration file under `<dir>/supabase/migrations` that creates
 * `table` and its version, reading each file individually so the specific
 * file is known. `dir` defaults to the workspace root.
 */
export async function findTableMigration(
  ctx: Pick<LocalStackEvalContext, 'exec' | 'folderExists'>,
  table: string,
  dir?: string
): Promise<TableMigrationProbe> {
  try {
    const exists =
      dir === undefined
        ? await ctx.folderExists('supabase/migrations')
        : (await ctx.exec(inProjectDir(dir, 'test -d supabase/migrations'))).ok;
    if (!exists) {
      return {
        ok: false,
        notes:
          'supabase/migrations does not exist — was a Supabase project initialised?',
      };
    }
    const listing = await ctx.exec(
      inProjectDir(dir, 'ls supabase/migrations 2>/dev/null | sort')
    );
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
    for (const file of files) {
      const match = file.match(MIGRATION_FILENAME_RE);
      if (!match) continue;
      const result = await ctx.exec(
        inProjectDir(dir, `cat ${shellQuote(`supabase/migrations/${file}`)}`)
      );
      if (result.ok && migrationCreatesTable(result.stdout, table)) {
        return { ok: true, version: match[1], file };
      }
    }
    return {
      ok: false,
      notes: `no migration contains CREATE TABLE for ${table}`,
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export function checkMigrationCreatesTable(
  name: string,
  migration: TableMigrationProbe
): CheckResult {
  return migration.ok
    ? {
        name,
        passed: true,
        notes: `${migration.file} (version ${migration.version})`,
      }
    : { name, passed: false, notes: migration.notes };
}

/**
 * Asserts the exact migration file that creates the table was applied
 * through the CLI's migration history in `stack` — not merely that the table
 * exists, which one created by hand would also satisfy.
 */
export async function checkMigrationApplied(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  name: string,
  stack: StackProbe,
  migration: TableMigrationProbe
): Promise<CheckResult> {
  if (!stack.ok) return { name, passed: false, notes: stack.notes };
  if (!migration.ok) return { name, passed: false, notes: migration.notes };
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc "select count(*) from supabase_migrations.schema_migrations where version = '${migration.version}'"`
    );
    if (!result.ok) {
      return { name, passed: false, notes: describeFailure(result) };
    }
    const count = Number(result.stdout.trim());
    const passed = Number.isFinite(count) && count >= 1;
    return {
      name,
      passed,
      notes: `version ${migration.version} (${migration.file}): ${
        passed
          ? 'found in applied history'
          : `not found in supabase_migrations.schema_migrations (count: ${result.stdout.trim()})`
      }`,
    };
  } catch (error) {
    return { name, passed: false, notes: errorMessage(error) };
  }
}

export type MigrationHistory =
  | { ok: true; history: Map<string, string> }
  | { ok: false; notes: string };

export type SortedMigrations<M extends { version: string }> =
  | { ok: true; recorded: M[]; missing: M[]; mismatched: M[] }
  | { ok: false; notes: string };

function parseHistory(stdout: string): MigrationHistory {
  const history = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const row = line.trim();
    if (row === '') continue;
    const match = HISTORY_ROW_RE.exec(row);
    if (match === null) {
      return {
        ok: false,
        notes: `unrecognised migration history row: ${row.slice(0, 120)}`,
      };
    }
    history.set(match[1], Buffer.from(match[2], 'hex').toString('utf8'));
  }
  return { ok: true, history };
}

/** Reads the statements the stack's migration history recorded for each of `versions`, keyed by version. */
export function readMigrationHistory(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  stack: StackProbe,
  versions: readonly string[]
): Promise<MigrationHistory> {
  const inList = versions.map((version) => `'${version}'`).join(', ');
  return queryDatabase(
    ctx,
    stack,
    `select version || '|' || encode(convert_to(coalesce(array_to_string(statements, ';' || chr(10)), ''), 'UTF8'), 'hex') from supabase_migrations.schema_migrations where version in (${inList})`,
    parseHistory
  );
}

/** Sorts `migrations` into those the history records with statements `matches` accepts, those it lacks and those it records with other statements; a `matches` that throws fails the sort with its message. */
export async function sortMigrationsByHistory<M extends { version: string }>(
  migrations: readonly M[],
  history: ReadonlyMap<string, string>,
  matches: (statements: string, migration: M) => boolean | Promise<boolean>
): Promise<SortedMigrations<M>> {
  const recorded: M[] = [];
  const missing: M[] = [];
  const mismatched: M[] = [];
  try {
    for (const migration of migrations) {
      const statements = history.get(migration.version);
      if (statements === undefined) {
        missing.push(migration);
      } else {
        const matched = await matches(statements, migration);
        (matched ? recorded : mismatched).push(migration);
      }
    }
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
  return { ok: true, recorded, missing, mismatched };
}

export const describeMissingVersions = (
  missing: readonly { version: string }[]
) =>
  `version(s) ${missing.map(({ version }) => version).join(', ')} not in supabase_migrations.schema_migrations`;

/** Passes when `probe` sorted every migration as recorded, otherwise names the missing and mismatched versions. */
export function checkMigrationsRecorded<M extends { version: string }>(
  name: string,
  probe: SortedMigrations<M>,
  {
    describeRecorded,
    describeMismatched,
    passedSuffix,
  }: {
    describeRecorded: (migrations: readonly M[]) => string;
    describeMismatched: (migrations: readonly M[]) => string;
    passedSuffix?: string;
  }
): CheckResult {
  if (!probe.ok) return { name, passed: false, notes: probe.notes };
  const problems = [
    ...(probe.missing.length > 0
      ? [describeMissingVersions(probe.missing)]
      : []),
    ...(probe.mismatched.length > 0
      ? [describeMismatched(probe.mismatched)]
      : []),
  ];
  if (problems.length > 0 || probe.recorded.length === 0) {
    return {
      name,
      passed: false,
      notes: problems.join('; ') || 'no migration is recorded',
    };
  }
  return {
    name,
    passed: true,
    notes: `${describeRecorded(probe.recorded)} ${probe.recorded.length === 1 ? 'is' : 'are'} in supabase_migrations.schema_migrations${passedSuffix === undefined ? '' : ` ${passedSuffix}`}`,
  };
}
