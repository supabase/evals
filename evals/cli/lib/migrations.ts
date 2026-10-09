import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
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
