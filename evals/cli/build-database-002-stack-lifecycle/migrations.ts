import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, shellQuote, type StackProbe } from './stack.js';

const CREATES_NOTES_RE =
  /create\s+table\s+(if\s+not\s+exists\s+)?("?public"?\.)?"?notes"?(?![\w$"])/i;
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
      const [span, next] = consumeQuoted(sql, i, ch);
      result += span;
      i = next;
      continue;
    }
    if (ch === '$') {
      const tagMatch = sql.slice(i).match(DOLLAR_TAG_RE);
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? sql.length : close + tag.length;
        result += sql.slice(i, end);
        i = end;
        continue;
      }
    }

    result += ch;
    i++;
  }
  return result;
}

/** Consumes a `quote`-delimited literal starting at `start` (its opening quote), doubled-quote escapes included. Returns the literal (with quotes) and the index just past it. */
function consumeQuoted(
  sql: string,
  start: number,
  quote: string
): [span: string, next: number] {
  let span = quote;
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        span += quote + quote;
        i += 2;
        continue;
      }
      span += quote;
      i++;
      break;
    }
    span += sql[i];
    i++;
  }
  return [span, i];
}

export type NotesMigrationProbe =
  | { ok: true; version: string; file: string }
  | { ok: false; notes: string };

/**
 * Finds the migration file that creates `notes` and its version, reading
 * each `supabase/migrations/*.sql` file individually so the specific file is
 * known. Shared by `checkMigrationCreatesNotes` and `checkMigrationApplied`
 * so both agree on which migration is "the" one — an agent can't pass by
 * leaving a notes-creating file unapplied while hand-creating the table.
 */
export async function findNotesMigration(
  ctx: LocalStackEvalContext
): Promise<NotesMigrationProbe> {
  try {
    if (!(await ctx.folderExists('supabase/migrations'))) {
      return {
        ok: false,
        notes:
          'supabase/migrations does not exist — was a Supabase project initialised?',
      };
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
    for (const file of files) {
      const match = file.match(MIGRATION_FILENAME_RE);
      if (!match) continue;
      const result = await ctx.exec(
        `cat ${shellQuote(`supabase/migrations/${file}`)}`
      );
      if (result.ok && CREATES_NOTES_RE.test(stripSqlComments(result.stdout))) {
        return { ok: true, version: match[1], file };
      }
    }
    return {
      ok: false,
      notes: 'no migration contains CREATE TABLE for notes',
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, notes: msg };
  }
}

export function checkMigrationCreatesNotes(
  notesMigration: NotesMigrationProbe
): CheckResult {
  const name = 'notes table is created by a migration file';
  if (!notesMigration.ok) {
    return { name, passed: false, notes: notesMigration.notes };
  }
  return {
    name,
    passed: true,
    notes: `${notesMigration.file} (version ${notesMigration.version})`,
  };
}

/**
 * Asserts the exact migration that creates `notes` was applied through the
 * migration flow — not merely that some migration ran, which a hand-created
 * `notes` table applied alongside an unrelated migration would also satisfy.
 */
export async function checkMigrationApplied(
  ctx: LocalStackEvalContext,
  stack: StackProbe,
  notesMigration: NotesMigrationProbe
): Promise<CheckResult> {
  const name =
    'the migration that creates notes is applied to the running stack';
  if (!stack.ok) return { name, passed: false, notes: stack.notes };
  if (!notesMigration.ok) {
    return { name, passed: false, notes: notesMigration.notes };
  }
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc "select count(*) from supabase_migrations.schema_migrations where version = '${notesMigration.version}'"`
    );
    if (!result.ok) {
      return { name, passed: false, notes: describeFailure(result) };
    }
    const count = Number(result.stdout.trim());
    const passed = Number.isFinite(count) && count >= 1;
    return {
      name,
      passed,
      notes: `version ${notesMigration.version} (${notesMigration.file}): ${
        passed
          ? 'found in applied history'
          : `not found in supabase_migrations.schema_migrations (count: ${result.stdout.trim()})`
      }`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}
