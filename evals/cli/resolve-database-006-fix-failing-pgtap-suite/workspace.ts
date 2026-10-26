import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { maskSqlLiteralsAndComments } from '../lib/migrations.js';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import {
  MIGRATIONS_DIR,
  readSeedFile,
  SEEDED_MIGRATIONS,
  SEEDED_TEST_FILES,
  SEEDED_TESTS,
  TESTS_DIR,
} from './fixtures.js';
import { splitSqlStatements, sqlFingerprint } from './sql.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type MigrationFile = { name: string; version: string; sql: string };

export type WorkspaceProbe =
  | {
      ok: true;
      migrations: MigrationFile[];
      seededTests: { file: string; sql: string | null }[];
      testFiles: string[];
    }
  | { ok: false; notes: string };

type MigrationsProbe =
  | { ok: true; migrations: MigrationFile[] }
  | { ok: false; notes: string };

export const TESTS_UNCHANGED_CHECK = 'the seeded tests were left as they were';

const MIGRATION_FILE_RE = /^(\d+)_(.*)\.sql$/;
const PLAN_STATEMENT_RE = /^select\s+(?:\*\s+from\s+)?plan\s*\(\s*(\d+)\s*\)$/i;
const ASSERTION_CALL_RE =
  /^select\s+(?:\*\s+from\s+)?(?:extensions\s*\.\s*)?([a-z_][a-z0-9_]*)\s*\(/i;
const INSERT_RE = /^insert\s+into\s/i;
const ON_CONFLICT_UPDATE_RE = /\bon\s+conflict\b[\s\S]*\bdo\s+update\b/i;
const RETURNING_OR_SELECT_RE = /\b(?:returning|select)\b/i;
const QUOTED_IDENTIFIER_RE = /"(?:[^"]|"")*"/g;
const IDENTIFIER = String.raw`"(?:[^"]|"")*"|[^\s".(,;]+`;
const INSERT_TARGET_RE = new RegExp(
  `^insert\\s+into\\s+((?:${IDENTIFIER})(?:\\s*\\.\\s*(?:${IDENTIFIER}))*)`,
  'i'
);
const IDENTIFIER_RE = new RegExp(IDENTIFIER, 'g');
const PGTAP_INTERNAL_TABLE_PREFIX = '__t';
const PGTAP_INTERNAL_SCHEMAS: ReadonlySet<string> = new Set([
  'extensions',
  'pg_catalog',
]);
const INSERT_ANYWHERE_RE = /\binsert\s+into\b/i;
const INVOICE_ROW_ID_RE = /\(\s*(\d+)\s*,/g;
const INVOICES_INSERT_RE = /^insert\s+into\s+public\s*\.\s*invoices\b/i;
const MAX_NOTED_STATEMENT = 80;

// The statements a seeded test file may gain besides comments and the plan: a pgTAP assertion call that spans the whole
// statement, or a plain test-data insert. Plan, todo and skip functions, `finish` and `set_config` may not appear in either.
const ASSERTION_NAMES: ReadonlySet<string> = new Set([
  'ok',
  'is',
  'isnt',
  'matches',
  'imatches',
  'doesnt_match',
  'doesnt_imatch',
  'alike',
  'ialike',
  'unalike',
  'unialike',
  'cmp_ok',
  'pass',
  'fail',
  'isa_ok',
  'throws_ok',
  'throws_like',
  'throws_ilike',
  'throws_matching',
  'throws_imatching',
  'lives_ok',
  'performs_ok',
  'performs_within',
  'results_eq',
  'results_ne',
  'set_eq',
  'set_ne',
  'set_has',
  'set_hasnt',
  'bag_eq',
  'bag_ne',
  'bag_has',
  'bag_hasnt',
  'is_empty',
  'row_eq',
  'diag',
  'fk_ok',
]);
const ASSERTION_PREFIXES: readonly string[] = [
  'has_',
  'hasnt_',
  'col_',
  'is_',
  'isnt_',
  'function_',
  'volatility_is',
  'trigger_is',
  'policy_',
  'policies_are',
  'tables_are',
  'columns_are',
];
// Searched for in the raw text with double quotes removed, so `"todo"(...)` and calls inside strings and `$$` bodies count.
const UNSAFE_CALL_RE =
  /\b(?:todo|todo_start|todo_end|in_todo|skip|plan|no_plan|finish|set_config)\s*\(/i;
// An allowed assertion can run SQL from a string or `$$` body, so these are searched for in the raw text, literals included.
const STATE_CHANGING_KEYWORDS: readonly string[] = [
  'create',
  'alter',
  'drop',
  'update',
  'delete',
  'truncate',
  'grant',
  'revoke',
  'comment on',
  'set_config',
  'set role',
  'set search_path',
  'set session',
  'set local',
  'reset',
  'do',
  'call',
  'copy',
  'security definer',
];
const STATE_CHANGING_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${STATE_CHANGING_KEYWORDS.map((keyword) => keyword.replace(/ /g, '\\s+')).join('|')})(?![\\p{L}\\p{N}_])`,
  'iu'
);
const TEST_FILE_RE = /\.(?:sql|pg)$/;
const TESTS_PREFIX = `${TESTS_DIR}/`;

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function readMigrations(ctx: ExecContext): Promise<MigrationsProbe> {
  const listing = await ctx.exec(`ls -1 ${MIGRATIONS_DIR}`);
  if (!listing.ok) {
    return {
      ok: false,
      notes: `could not list ${MIGRATIONS_DIR}: ${describeFailure(listing)}`,
    };
  }
  const migrations: MigrationFile[] = [];
  for (const name of listing.stdout.split('\n')) {
    const version = MIGRATION_FILE_RE.exec(name)?.[1];
    if (version === undefined) continue;
    const read = await ctx.exec(
      `cat ${shellQuote(`${MIGRATIONS_DIR}/${name}`)}`
    );
    if (!read.ok) {
      return {
        ok: false,
        notes: `could not read ${name}: ${describeFailure(read)}`,
      };
    }
    migrations.push({ name, version, sql: read.stdout });
  }
  migrations.sort(
    (a, b) => compareText(a.version, b.version) || compareText(a.name, b.name)
  );
  return { ok: true, migrations };
}

async function listTestFiles(ctx: ExecContext): Promise<string[]> {
  const found = await ctx.exec(
    `find ${TESTS_DIR} -type f \\( -name '*.sql' -o -name '*.pg' \\)`
  );
  if (!found.ok) return [];
  return found.stdout
    .split('\n')
    .filter((line) => line.startsWith(TESTS_PREFIX) && TEST_FILE_RE.test(line))
    .map((line) => line.slice(TESTS_PREFIX.length))
    .sort(compareText);
}

/** The migration files in version order, each seeded test file as the agent left it (null when gone), and every test file under `supabase/tests`. */
export async function readWorkspace(ctx: ExecContext): Promise<WorkspaceProbe> {
  try {
    const read = await readMigrations(ctx);
    if (!read.ok) return read;
    const seededTests: { file: string; sql: string | null }[] = [];
    for (const file of SEEDED_TEST_FILES) {
      const cat = await ctx.exec(`cat ${shellQuote(`${TESTS_PREFIX}${file}`)}`);
      seededTests.push({ file, sql: cat.ok ? cat.stdout : null });
    }
    return {
      ok: true,
      migrations: read.migrations,
      seededTests,
      testFiles: await listTestFiles(ctx),
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

const plansOf = (statements: readonly string[]) =>
  statements.flatMap((statement) => {
    const plan = PLAN_STATEMENT_RE.exec(statement)?.[1];
    return plan === undefined ? [] : [Number(plan)];
  });

const isKnownAssertion = (name: string) =>
  ASSERTION_NAMES.has(name) ||
  ASSERTION_PREFIXES.some((prefix) => name.startsWith(prefix));

/** The ids the pristine seeded tests insert into `public.invoices`. */
function seededInvoiceIds(): string[] {
  const ids = SEEDED_TESTS.flatMap(({ sql }) =>
    splitSqlStatements(sql)
      .filter((statement) => INVOICES_INSERT_RE.test(statement))
      .flatMap((statement) =>
        Array.from(
          maskSqlLiteralsAndComments(statement).matchAll(INVOICE_ROW_ID_RE),
          (row) => row[1]
        )
      )
  );
  return Array.from(new Set(ids));
}

const SEEDED_INVOICE_IDS_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${seededInvoiceIds().join('|')})(?![\\p{L}\\p{N}_])`,
  'u'
);

/** Whether an insert's target is one of pgTAP's own tables or lives in a schema the extensions own. */
function insertsIntoPgtapTable(statement: string): boolean {
  const target = INSERT_TARGET_RE.exec(statement)?.[1];
  if (target === undefined) return true;
  const parts = Array.from(target.matchAll(IDENTIFIER_RE), ([name]) =>
    name.replace(/^"|"$/g, '').replaceAll('""', '"').toLowerCase()
  );
  const table = parts[parts.length - 1];
  const schema = parts[parts.length - 2];
  return (
    table.startsWith(PGTAP_INTERNAL_TABLE_PREFIX) ||
    (schema !== undefined && PGTAP_INTERNAL_SCHEMAS.has(schema))
  );
}

/** Whether the parenthesis opening at `open` closes at the last character of `text`. */
function callSpans(text: string, open: number): boolean {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i === text.length - 1;
  }
  return false;
}

/** Whether a statement added to a seeded test file is a pgTAP assertion call or a test-data insert, the only additions that can't change what the seeded assertions run against. */
function isAllowedAddition(statement: string): boolean {
  if (STATE_CHANGING_RE.test(statement)) return false;
  if (UNSAFE_CALL_RE.test(statement.replaceAll('"', ''))) return false;
  const masked = maskSqlLiteralsAndComments(statement)
    .replace(QUOTED_IDENTIFIER_RE, '""')
    .trim();
  const touchesSeededInvoice = SEEDED_INVOICE_IDS_RE.test(statement);
  if (INSERT_RE.test(masked)) {
    return (
      !ON_CONFLICT_UPDATE_RE.test(masked) &&
      !RETURNING_OR_SELECT_RE.test(masked) &&
      !insertsIntoPgtapTable(statement) &&
      !touchesSeededInvoice
    );
  }
  const call = ASSERTION_CALL_RE.exec(masked);
  if (call === null) return false;
  const name = call[1].toLowerCase();
  // A throws_ assertion's insert is expected to fail, so it adds no rows.
  const insertsSeededData =
    touchesSeededInvoice &&
    !name.startsWith('throws_') &&
    INSERT_ANYWHERE_RE.test(statement);
  return (
    isKnownAssertion(name) &&
    callSpans(masked, call[0].length - 1) &&
    !insertsSeededData
  );
}

type SeededFile =
  | { kept: true; added: number }
  | { kept: false; disallowed?: string };

/** Whether `workspace` holds every statement of `pristine` in order, one plan no lower, and no added statement beyond assertions and test-data inserts. */
function inspectSeededFile(pristine: string, workspace: string): SeededFile {
  const seeded = splitSqlStatements(pristine);
  const current = splitSqlStatements(workspace);
  const [seededPlan = 0] = plansOf(seeded);
  const currentPlans = plansOf(current);
  if (currentPlans.length !== 1 || currentPlans[0] < seededPlan) {
    return { kept: false };
  }
  const fingerprints = current.map(sqlFingerprint);
  const matched = new Set<number>();
  let next = 0;
  for (const statement of seeded) {
    if (PLAN_STATEMENT_RE.test(statement)) continue;
    const found = fingerprints.indexOf(sqlFingerprint(statement), next);
    if (found === -1) return { kept: false };
    matched.add(found);
    next = found + 1;
  }
  const added = current.filter(
    (statement, index) =>
      !matched.has(index) && !PLAN_STATEMENT_RE.test(statement)
  );
  const disallowed = added.find((statement) => !isAllowedAddition(statement));
  return disallowed === undefined
    ? { kept: true, added: added.length }
    : { kept: false, disallowed };
}

function describeAddition(statement: string): string {
  const flat = statement.replace(/\s+/g, ' ');
  return flat.length > MAX_NOTED_STATEMENT
    ? `${flat.slice(0, MAX_NOTED_STATEMENT)}...`
    : flat;
}

/** Passes when every seeded test file is still there with all its statements in order and a plan no lower, ignoring comments and whitespace; the only statements it may gain are pgTAP assertions and test-data inserts. */
export function checkSeededTestsUnchanged(probe: WorkspaceProbe): CheckResult {
  const name = TESTS_UNCHANGED_CHECK;
  if (!probe.ok) return { name, passed: false, notes: probe.notes };
  const modified: string[] = [];
  const missing: string[] = [];
  const extended: string[] = [];
  for (const seeded of SEEDED_TESTS) {
    const sql =
      probe.seededTests.find(({ file }) => file === seeded.file)?.sql ?? null;
    if (sql === null) {
      missing.push(seeded.file);
      continue;
    }
    const inspected = inspectSeededFile(seeded.sql, sql);
    if (!inspected.kept) {
      modified.push(
        inspected.disallowed === undefined
          ? seeded.file
          : `${seeded.file} (added a statement the check doesn't allow: ${describeAddition(inspected.disallowed)})`
      );
    } else if (inspected.added > 0) {
      extended.push(
        `added to ${seeded.file}: ${inspected.added} ${inspected.added === 1 ? 'statement' : 'statements'}`
      );
    }
  }
  if (modified.length === 0 && missing.length === 0) {
    return {
      name,
      passed: true,
      notes: [
        `${SEEDED_TESTS.length} seeded test files unchanged`,
        ...extended,
      ].join('; '),
    };
  }
  return {
    name,
    passed: false,
    notes: [
      ...(modified.length > 0 ? [`modified: ${modified.join(', ')}`] : []),
      ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
    ].join('; '),
  };
}

/** How the workspace's migration files differ from the seeded ones, comparing statements and ignoring comments and whitespace. */
export function diffSeededMigrations(migrations: readonly MigrationFile[]): {
  added: string[];
  modified: string[];
  missing: string[];
} {
  const byName = new Map(migrations.map(({ name, sql }) => [name, sql]));
  return {
    added: migrations
      .map(({ name }) => name)
      .filter((name) => !SEEDED_MIGRATIONS.includes(name)),
    modified: SEEDED_MIGRATIONS.filter((name) => {
      const sql = byName.get(name);
      return (
        sql !== undefined &&
        sqlFingerprint(sql) !==
          sqlFingerprint(readSeedFile(`${MIGRATIONS_DIR}/${name}`))
      );
    }),
    missing: SEEDED_MIGRATIONS.filter((name) => !byName.has(name)),
  };
}
