import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  maskSqlLiteralsAndComments,
  stripSqlComments,
} from '../lib/migrations.js';
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
const ON_CONFLICT_RE = /\bon\s+conflict\b/i;
const VALUES_RE = /\bvalues\b/i;
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
// Searched for with double quotes removed, so `"todo"(...)` and calls inside SQL-reading strings and `$$` bodies count.
const UNSAFE_CALL_RE =
  /\b(?:todo|todo_start|todo_end|in_todo|skip|plan|no_plan|finish|set_config)\s*\(/i;
// Searched for in the code outside literals; the literals pgTAP could run as SQL are checked against statement forms.
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
const SQL_IDENTIFIER = String.raw`(?:"(?:[^"]|"")*"|[\p{L}_][\p{L}\p{N}_$]*)`;
const QUALIFIED_NAME = `${SQL_IDENTIFIER}(?:\\s*\\.\\s*${SQL_IDENTIFIER})*`;
const OBJECT_KINDS: readonly string[] = [
  'access\\s+method',
  'aggregate',
  'cast',
  'collation',
  'conversion',
  'constraint\\s+trigger',
  'database',
  'default\\s+(?:privileges|conversion)',
  'domain',
  'event\\s+trigger',
  'extension',
  'foreign',
  'function',
  'global',
  'group',
  'index',
  'language',
  'large\\s+object',
  'local',
  'materialized',
  'operator',
  'or\\s+replace',
  'owned\\s+by',
  'policy',
  'procedural',
  'procedure',
  'publication',
  'recursive',
  'role',
  'routine',
  'rule',
  'schema',
  'sequence',
  'server',
  'statistics',
  'subscription',
  'system',
  'table',
  'tablespace',
  'temp',
  'temporary',
  'text\\s+search',
  'transform',
  'trigger',
  'trusted',
  'type',
  'unique',
  'unlogged',
  'user',
  'view',
];
const PRIVILEGE_ITEM = `(?:all(?:\\s+privileges)?|alter\\s+system|${SQL_IDENTIFIER})(?:\\s*\\([^)]*\\))?`;
const WORD_END = '(?![\\p{L}\\p{N}_])';
// Each form needs the words Postgres puts after the command word, so a description such as `'delete is blocked'` doesn't match.
// `$` is the end of the body, since the patterns have no `m` flag.
const STATE_CHANGING_STATEMENTS: readonly string[] = [
  `(?:create|alter|drop)\\s+(?:${OBJECT_KINDS.join('|')})${WORD_END}`,
  `update\\s+(?:only\\s+)?${QUALIFIED_NAME}(?:\\s*\\*)?(?:\\s+(?:as\\s+)?${SQL_IDENTIFIER})?\\s+set${WORD_END}`,
  `delete\\s+from${WORD_END}`,
  `merge\\s+into${WORD_END}`,
  `truncate\\s+(?:table\\s+)?(?:only\\s+)?${QUALIFIED_NAME}(?:\\s*\\*)?(?:\\s*(?:[,;)]|$)|\\s+(?:restart|continue|cascade|restrict)${WORD_END})`,
  `(?:grant|revoke)\\s+(?:(?:grant|admin|inherit|set)\\s+option\\s+for\\s+)?${PRIVILEGE_ITEM}(?:\\s*,\\s*${PRIVILEGE_ITEM})*\\s+(?:on|to|from)${WORD_END}`,
  `comment\\s+on${WORD_END}`,
  `set_config${WORD_END}`,
  `set\\s+(?:role|search_path|session|local)${WORD_END}`,
  `reset\\s+(?:all|role|session\\s+authorization|${QUALIFIED_NAME})\\s*(?:;|$)`,
  `do\\s+(?:language\\s+${SQL_IDENTIFIER}\\s+)?(?:\\$|[eE]?')`,
  `call\\s+${QUALIFIED_NAME}\\s*\\(`,
  `copy\\s+(?:\\(|${QUALIFIED_NAME}(?:\\s*\\([^)]*\\))?\\s+(?:from|to)${WORD_END})`,
  `on\\s+conflict${WORD_END}`,
  `security\\s+definer${WORD_END}`,
];
const STATE_CHANGING_STATEMENT_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${STATE_CHANGING_STATEMENTS.join('|')})`,
  'iu'
);
const SQL_COMMANDS: readonly string[] = [
  'abort',
  'alter',
  'analyze',
  'begin',
  'call',
  'checkpoint',
  'close',
  'cluster',
  'comment',
  'commit',
  'copy',
  'create',
  'deallocate',
  'declare',
  'delete',
  'discard',
  'do',
  'drop',
  'end',
  'execute',
  'explain',
  'fetch',
  'grant',
  'import',
  'insert',
  'listen',
  'load',
  'lock',
  'merge',
  'move',
  'notify',
  'prepare',
  'reassign',
  'refresh',
  'reindex',
  'release',
  'reset',
  'revoke',
  'rollback',
  'savepoint',
  'security',
  'select',
  'set',
  'show',
  'start',
  'table',
  'truncate',
  'unlisten',
  'update',
  'vacuum',
  'values',
  'with',
];
const SQL_COMMAND_START_RE = new RegExp(
  `^[\\s(;]*(?:${SQL_COMMANDS.join('|')})(?![\\p{L}\\p{N}_])`,
  'iu'
);
const DOLLAR_TAG_RE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;
const ESCAPE_STRING_TOKEN_RE =
  /''|\\(?:([0-7]{1,3})|x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|([\s\S]))/g;
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};
const FINGERPRINT_DROPPED_RE = /[\s;]/;
const TEST_FILE_RE = /\.(?:sql|pg)$/;
const TESTS_PREFIX = `${TESTS_DIR}/`;

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const countOf = (count: number, noun: string) =>
  `${count} ${count === 1 ? noun : `${noun}s`}`;

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

const maskStatement = (statement: string) =>
  maskSqlLiteralsAndComments(statement)
    .replace(QUOTED_IDENTIFIER_RE, '""')
    .trim();

/** Whether the `'` at `quote` opens an `E'...'` escape string, where a backslash escapes the next character. */
const isEscapeString = (sql: string, quote: number) =>
  /[Ee]/.test(sql[quote - 1] ?? '') && !/[\w$]/.test(sql[quote - 2] ?? '');

/** The index of the quote that closes the literal opened at `open`, or the length of `sql` when it never closes. */
function closingQuote(
  sql: string,
  open: number,
  backslashEscapes: boolean
): number {
  const quote = sql[open];
  let i = open + 1;
  while (i < sql.length) {
    if (backslashEscapes && sql[i] === '\\') i += 2;
    else if (sql[i] !== quote) i++;
    else if (sql[i + 1] === quote) i += 2;
    else return i;
  }
  return sql.length;
}

const isScalarValue = (code: number) =>
  code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);

/** The text an `E'...'` body stands for, keeping an escape raw when it names no valid code point. */
function decodeEscapeString(body: string): string {
  return body.replace(
    ESCAPE_STRING_TOKEN_RE,
    (match, octal, hex, short, long, other) => {
      if (match === "''") return "'";
      if (other !== undefined) return SIMPLE_ESCAPES[other] ?? other;
      const code =
        octal === undefined
          ? Number.parseInt(hex ?? short ?? long, 16)
          : Number.parseInt(octal, 8);
      return isScalarValue(code) ? String.fromCodePoint(code) : match;
    }
  );
}

/** The text each string and dollar-quoted literal in `sql` stands for; literals nested in a body stay in it. */
function literalBodies(sql: string): string[] {
  const bodies: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    if (char === "'" || char === '"') {
      const escaped = char === "'" && isEscapeString(sql, i);
      const close = closingQuote(sql, i, escaped);
      if (char === "'") {
        const body = sql.slice(i + 1, close);
        bodies.push(
          escaped ? decodeEscapeString(body) : body.replaceAll("''", "'")
        );
      }
      i = close + 1;
      continue;
    }
    const tag =
      char === '$' ? DOLLAR_TAG_RE.exec(sql.slice(i))?.[0] : undefined;
    if (tag === undefined) {
      i++;
      continue;
    }
    const close = sql.indexOf(tag, i + tag.length);
    const end = close === -1 ? sql.length : close;
    bodies.push(sql.slice(i + tag.length, end));
    i = end + tag.length;
  }
  return bodies;
}

const readsAsSql = (body: string) =>
  SQL_COMMAND_START_RE.test(stripSqlComments(body));

/** The body of each literal in `sql` that pgTAP could run as SQL, and of each such literal nested in one. */
function sqlBodies(sql: string): string[] {
  return literalBodies(stripSqlComments(sql))
    .filter(readsAsSql)
    .flatMap((body) => [body, ...sqlBodies(body)]);
}

/** Whether the code outside literals holds a state-changing keyword, or a literal pgTAP could run holds a state-changing statement. */
function changesState(statement: string): boolean {
  return (
    STATE_CHANGING_RE.test(maskSqlLiteralsAndComments(statement)) ||
    sqlBodies(statement).some((body) =>
      STATE_CHANGING_STATEMENT_RE.test(stripSqlComments(body))
    )
  );
}

/** Whether the code outside literals, or a literal pgTAP could run, calls a function that can hide or end an assertion. */
function callsUnsafeFunction(statement: string): boolean {
  return [maskSqlLiteralsAndComments(statement), ...sqlBodies(statement)].some(
    (text) => UNSAFE_CALL_RE.test(text.replaceAll('"', ''))
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
  if (changesState(statement) || callsUnsafeFunction(statement)) return false;
  const masked = maskStatement(statement);
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

/** The text of `statement` after the leading part whose fingerprint is `prefix`, or undefined when the statement doesn't start with it. */
function textAfterFingerprint(
  statement: string,
  prefix: string
): string | undefined {
  if (!sqlFingerprint(statement).startsWith(prefix)) return undefined;
  let left = prefix.length;
  for (let i = 0; i < statement.length; i++) {
    if (!FINGERPRINT_DROPPED_RE.test(statement[i]) && --left === 0) {
      return statement.slice(i + 1);
    }
  }
  return undefined;
}

/** How many `, (...)` tuples make up all of the masked `tail`, or 0 when it holds anything else. */
function countRowTuples(tail: string): number {
  let rows = 0;
  let depth = 0;
  let expected = ',';
  for (const char of tail) {
    if (depth > 0) {
      if (char === '(') depth++;
      else if (char === ')' && --depth === 0) expected = ',';
      continue;
    }
    if (/\s/.test(char)) continue;
    if (char !== expected) return 0;
    if (char === ',') {
      expected = '(';
    } else {
      depth = 1;
      rows++;
    }
  }
  return depth === 0 && expected === ',' ? rows : 0;
}

/** Whether a seeded statement is an `insert ... values (...), ...` that new rows can be appended to. */
function isExtendableInsert(seeded: string): boolean {
  const masked = maskStatement(seeded);
  return (
    INSERT_RE.test(masked) &&
    VALUES_RE.test(masked) &&
    masked.endsWith(')') &&
    !ON_CONFLICT_RE.test(masked) &&
    !RETURNING_OR_SELECT_RE.test(masked)
  );
}

/** How many rows `statement` appends to the seeded insert whose fingerprint is `prefix`, or 0 when it isn't that insert followed only by safe new `, (...)` rows. */
function appendedRowCount(statement: string, prefix: string): number {
  const tail = textAfterFingerprint(statement, prefix);
  if (tail === undefined) return 0;
  const masked = maskStatement(tail);
  const unsafe =
    RETURNING_OR_SELECT_RE.test(masked) ||
    SEEDED_INVOICE_IDS_RE.test(tail) ||
    changesState(tail) ||
    callsUnsafeFunction(tail);
  return unsafe ? 0 : countRowTuples(masked);
}

function findExtension(
  seeded: string,
  current: readonly string[],
  from: number
): { index: number; rows: number } | undefined {
  if (!isExtendableInsert(seeded)) return undefined;
  const prefix = sqlFingerprint(seeded);
  for (let index = from; index < current.length; index++) {
    const rows = appendedRowCount(current[index], prefix);
    if (rows > 0) return { index, rows };
  }
  return undefined;
}

type SeededFile =
  | { kept: true; added: number; appendedRows: number }
  | { kept: false; disallowed?: string };

/** Whether `workspace` holds every statement of `pristine` in order, one plan no lower, and no added statement beyond assertions, test-data inserts and new rows appended to a seeded insert. */
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
  let appendedRows = 0;
  for (const statement of seeded) {
    if (PLAN_STATEMENT_RE.test(statement)) continue;
    let found = fingerprints.indexOf(sqlFingerprint(statement), next);
    if (found === -1) {
      const extension = findExtension(statement, current, next);
      if (extension === undefined) return { kept: false };
      found = extension.index;
      appendedRows += extension.rows;
    }
    matched.add(found);
    next = found + 1;
  }
  const added = current.filter(
    (statement, index) =>
      !matched.has(index) && !PLAN_STATEMENT_RE.test(statement)
  );
  const disallowed = added.find((statement) => !isAllowedAddition(statement));
  return disallowed === undefined
    ? { kept: true, added: added.length, appendedRows }
    : { kept: false, disallowed };
}

function describeAddition(statement: string): string {
  const flat = statement.replace(/\s+/g, ' ');
  return flat.length > MAX_NOTED_STATEMENT
    ? `${flat.slice(0, MAX_NOTED_STATEMENT)}...`
    : flat;
}

/** Passes when every seeded test file is still there with all its statements in order and a plan no lower, ignoring comments and whitespace; it may gain pgTAP assertions, test-data inserts and new rows appended to a seeded insert. */
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
    } else if (inspected.added > 0 || inspected.appendedRows > 0) {
      const parts = [
        ...(inspected.added > 0 ? [countOf(inspected.added, 'statement')] : []),
        ...(inspected.appendedRows > 0
          ? [
              `${countOf(inspected.appendedRows, 'row')} appended to seeded inserts`,
            ]
          : []),
      ];
      extended.push(`added to ${seeded.file}: ${parts.join(', ')}`);
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
