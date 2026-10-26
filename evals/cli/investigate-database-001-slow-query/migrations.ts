import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  checkMigrationsRecorded,
  maskSqlLiteralsAndComments,
  readMigrationHistory,
  sortMigrationsByHistory,
  type SortedMigrations,
} from '../lib/migrations.js';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';
import {
  EMAIL_COLUMN,
  ORDERS_TABLE,
  SEEDED_MIGRATION_FILE,
  SEEDED_MIGRATION_VERSION,
} from './fixtures.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type IndexStatement = { name?: string; keys: string[] };
export type IndexMigration = { file: string; version: string };
export type IndexMigrationsProbe =
  | { ok: true; migrations: IndexMigration[]; notes: string }
  | { ok: false; notes: string };
export type RecordedProbe = SortedMigrations<IndexMigration>;

export const MIGRATION_CHECK_NAME =
  'a new migration creates an index on orders.customer_email';
export const RECORDED_CHECK_NAME =
  'that migration is recorded in the local migration history';

const MIGRATION_FILENAME_RE = /^(\d+)_(.+)\.sql$/;
const IDENTIFIER = String.raw`"[^"]+"|[^\s"(),;]+`;
const NAME = String.raw`(?:[a-z_][\w$]*|"[^"]+")`;
const CREATE_INDEX_RE = new RegExp(
  String.raw`^\s*create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:(${IDENTIFIER})\s+)?on\s+(?:only\s+)?(?:"?public"?\s*\.\s*)?"?${ORDERS_TABLE}"?\s*(?:using\s+(?:\w+|"[^"]+")\s*)?\(`,
  'i'
);
const EMAIL_KEY_RE = new RegExp(
  String.raw`^"?${EMAIL_COLUMN}"?(?:\s+${NAME}(?:\s*\.\s*${NAME})*)*$`,
  'i'
);
const NO_NEW_MIGRATION_NOTE = `no new migration creates an index on ${ORDERS_TABLE}.${EMAIL_COLUMN}`;

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level key texts of the index column list that `text` starts inside and the offset of its closing parenthesis, or undefined when it never closes. */
function splitKeys(text: string): { keys: string[]; end: number } | undefined {
  const keys: string[] = [];
  let depth = 1;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === '(') {
      depth++;
    } else if (!quoted && char === ')' && --depth === 0) {
      keys.push(text.slice(start, i));
      return { keys: keys.map((key) => key.trim()), end: i };
    } else if (!quoted && char === ',' && depth === 1) {
      keys.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return undefined;
}

/** `key` with the redundant parentheses around its leading expression removed, since `((col) desc)` indexes the plain column. */
function unwrapLeadingParens(key: string): string {
  if (!key.startsWith('(')) return key;
  const group = splitKeys(key.slice(1));
  if (group === undefined || group.keys.length !== 1) return key;
  return unwrapLeadingParens(
    `${group.keys[0]} ${key.slice(group.end + 2)}`.trim()
  );
}

/** The `create index` statements on `public.orders` outside comments and literals, in file order. */
export function findOrdersIndexStatements(sql: string): IndexStatement[] {
  return maskSqlLiteralsAndComments(sql)
    .split(';')
    .flatMap((statement): IndexStatement[] => {
      const create = CREATE_INDEX_RE.exec(statement);
      if (create === null) return [];
      const keys = splitKeys(statement.slice(create[0].length))?.keys;
      if (keys === undefined) return [];
      const name = create[1]?.replace(/^"(.*)"$/, '$1');
      return [{ ...(name === undefined ? {} : { name }), keys }];
    });
}

/** Whether `sql` creates an index on `public.orders` whose first key is the bare `customer_email` column. */
export function createsEmailIndex(sql: string): boolean {
  return findOrdersIndexStatements(sql).some(
    ({ keys }) =>
      keys.length > 0 && EMAIL_KEY_RE.test(unwrapLeadingParens(keys[0]))
  );
}

export const describeMigrations = (migrations: readonly IndexMigration[]) =>
  migrations
    .map(({ file, version }) => `${file} (version ${version})`)
    .join(', ');

function describeNone(
  newFiles: readonly string[],
  seededCreates: boolean,
  earlier: readonly string[]
): string {
  return [
    newFiles.length === 0
      ? 'no new migration files'
      : `none of ${newFiles.join(', ')} creates an index on ${ORDERS_TABLE}.${EMAIL_COLUMN}`,
    ...(seededCreates
      ? [`only the seeded migration ${SEEDED_MIGRATION_FILE} creates it`]
      : []),
    ...earlier.map(
      (file) =>
        `${file} creates it but is dated at or before the seeded version ${SEEDED_MIGRATION_VERSION}, so a reset runs it before ${ORDERS_TABLE} exists`
    ),
  ].join('; ');
}

/** Finds the migration files newer than the seeded one that create an index on `orders.customer_email`. */
export async function findEmailIndexMigrations(
  ctx: ExecContext
): Promise<IndexMigrationsProbe> {
  try {
    const listing = await ctx.exec('ls supabase/migrations 2>/dev/null | sort');
    if (!listing.ok || listing.stdout.trim() === '') {
      return {
        ok: false,
        notes: 'no migration files found under supabase/migrations',
      };
    }

    const newFiles: IndexMigration[] = [];
    const found: IndexMigration[] = [];
    const earlier: string[] = [];
    let seededCreates = false;
    for (const line of listing.stdout.split('\n')) {
      const file = line.trim();
      const version = MIGRATION_FILENAME_RE.exec(file)?.[1];
      if (version === undefined) continue;
      const result = await ctx.exec(
        `cat ${shellQuote(`supabase/migrations/${file}`)}`
      );
      if (!result.ok) {
        return {
          ok: false,
          notes: `could not read ${file}: ${describeFailure(result)}`,
        };
      }
      const creates = createsEmailIndex(result.stdout);
      if (file === SEEDED_MIGRATION_FILE) {
        seededCreates = creates;
      } else if (version > SEEDED_MIGRATION_VERSION) {
        newFiles.push({ file, version });
        if (creates) found.push({ file, version });
      } else if (creates) {
        earlier.push(file);
      }
    }

    const byVersion = (a: IndexMigration, b: IndexMigration) =>
      compareText(a.version, b.version) || compareText(a.file, b.file);
    found.sort(byVersion);
    return {
      ok: true,
      migrations: found,
      notes:
        found.length > 0
          ? describeMigrations(found)
          : describeNone(
              newFiles.map(({ file }) => file),
              seededCreates,
              earlier
            ),
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export function checkNewMigrationCreatesIndex(
  probe: IndexMigrationsProbe
): CheckResult {
  const name = MIGRATION_CHECK_NAME;
  if (!probe.ok || probe.migrations.length === 0) {
    return { name, passed: false, notes: probe.notes };
  }
  return { name, passed: true, notes: describeMigrations(probe.migrations) };
}

/** Reads which of the found migrations the local migration history holds with a statement that creates the index. */
export async function readRecordedIndexMigrations(
  ctx: ExecContext,
  stack: StackProbe,
  probe: IndexMigrationsProbe
): Promise<RecordedProbe> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  if (!probe.ok) return { ok: false, notes: probe.notes };
  const { migrations } = probe;
  if (migrations.length === 0) {
    return { ok: false, notes: NO_NEW_MIGRATION_NOTE };
  }
  const read = await readMigrationHistory(
    ctx,
    stack,
    migrations.map(({ version }) => version)
  );
  if (!read.ok) return read;
  return sortMigrationsByHistory(migrations, read.history, createsEmailIndex);
}

export const describeMismatchedVersions = (
  mismatched: readonly IndexMigration[]
) =>
  `version(s) ${mismatched.map(({ version }) => version).join(', ')} recorded with statements that do not create an index on ${ORDERS_TABLE}.${EMAIL_COLUMN}`;

export function checkMigrationRecorded(probe: RecordedProbe): CheckResult {
  return checkMigrationsRecorded(RECORDED_CHECK_NAME, probe, {
    describeRecorded: describeMigrations,
    describeMismatched: describeMismatchedVersions,
    passedSuffix: 'with the index statement',
  });
}
