import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  maskSqlLiteralsAndComments,
  migrationCreatesTable,
  stripSqlComments,
} from '../lib/migrations.js';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';
import {
  buildAccessProbeBody,
  checkReadIsolation,
  checkWriteIsolation,
  parseAccessProbeOutput,
  type AccessProbe,
} from './access.js';
import {
  NOTES_TABLE,
  SEEDED_MIGRATION_FILE,
  SEEDED_MIGRATION_VERSION,
  SEEDED_NOTES_POLICIES,
} from './fixtures.js';
import { compareText, psqlCommand } from './psql.js';
import { DROP_NOTES_POLICIES_SQL } from './snapshot.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type PolicyMigration = {
  version: string;
  file: string;
  seeded: boolean;
};
export type PolicyMigrationsProbe =
  | {
      ok: true;
      migrations: PolicyMigration[];
      misordered: string[];
      seededMissing?: true;
      notesNeverCreated?: true;
    }
  | { ok: false; notes: string };
export type RecordedPolicyMigrationsProbe =
  | {
      ok: true;
      recorded: PolicyMigration[];
      missing: PolicyMigration[];
      mismatched: PolicyMigration[];
    }
  | { ok: false; notes: string };

export const MIGRATION_CHECK_NAME =
  'the notes policy fix is in an applied migration';

const MIGRATIONS_DIR = 'supabase/migrations';
const NOTES_NEVER_CREATED = `the seeded migration is gone and no migration creates public.${NOTES_TABLE}, so a reset could not rebuild the table`;
const MIGRATION_FILENAME_RE = /^(\d+)_(.+)\.sql$/;
const HISTORY_ROW_RE = /^(\d+)\|((?:[0-9a-f]{2})*)$/i;
const NOTES = `(?:"?public"?\\s*\\.\\s*)?"?${NOTES_TABLE}"?(?![\\w$"])`;
const POLICY_RE = new RegExp(
  `^(?:create|alter|drop) policy (?:if exists )?(?:"(?:[^"]|"")*"|[^\\s"]+) on ${NOTES}`
);
const ROW_LEVEL_SECURITY_RE = new RegExp(
  `^alter table (?:if exists )?(?:only )?${NOTES}.*\\b(?:enable|disable|force|no force) row level security\\b`
);

const DO_RE = /^do\b/;
const DOLLAR_TAG_RE = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

const normalise = (statement: string) =>
  statement.replace(/\s+/g, ' ').trim().toLowerCase();

/** The index past the comment that starts at `i`, or undefined when none does. Block comments nest. */
function commentEnd(sql: string, i: number): number | undefined {
  const two = sql.slice(i, i + 2);
  if (two === '--') {
    const newline = sql.indexOf('\n', i);
    return newline === -1 ? sql.length : newline + 1;
  }
  if (two !== '/*') return undefined;
  let depth = 1;
  let j = i + 2;
  while (j < sql.length && depth > 0) {
    const pair = sql.slice(j, j + 2);
    if (pair === '/*') {
      depth++;
      j += 2;
    } else if (pair === '*/') {
      depth--;
      j += 2;
    } else {
      j++;
    }
  }
  return j;
}

function quotedEnd(sql: string, start: number, escapes: boolean): number {
  const quote = sql[start];
  let i = start + 1;
  while (i < sql.length) {
    if (escapes && sql[i] === '\\') {
      i += 2;
    } else if (sql[i] === quote) {
      if (sql[i + 1] !== quote) return i + 1;
      i += 2;
    } else {
      i++;
    }
  }
  return i;
}

/** The index past the quoted identifier, string literal or dollar-quoted body that starts at `i`, or undefined when none does. */
function literalEnd(sql: string, i: number): number | undefined {
  const ch = sql[i];
  if (ch === '"') return quotedEnd(sql, i, false);
  if (ch === "'") {
    const escapes =
      /[Ee]/.test(sql[i - 1] ?? '') && !/[\w$]/.test(sql[i - 2] ?? '');
    return quotedEnd(sql, i, escapes);
  }
  if (ch !== '$') return undefined;
  DOLLAR_TAG_RE.lastIndex = i;
  const tag = DOLLAR_TAG_RE.exec(sql)?.[0];
  if (tag === undefined) return undefined;
  const close = sql.indexOf(tag, i + tag.length);
  return close === -1 ? sql.length : close + tag.length;
}

/** The top-level statements of `sql` as written, split on `;` outside comments, quotes and dollar-quoted bodies, without the comments around each statement. */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = -1;
  let end = 0;
  const flush = () => {
    if (start !== -1) statements.push(sql.slice(start, end));
    start = -1;
  };
  let i = 0;
  while (i < sql.length) {
    const afterComment = commentEnd(sql, i);
    if (afterComment !== undefined) {
      i = afterComment;
    } else if (sql[i] === ';') {
      flush();
      i++;
    } else if (/\s/.test(sql[i])) {
      i++;
    } else {
      if (start === -1) start = i;
      i = literalEnd(sql, i) ?? i + 1;
      end = i;
    }
  }
  flush();
  return statements;
}

export type AccessRule = { text: string; key: string };

function accessRule(text: string): AccessRule | undefined {
  const masked = normalise(maskSqlLiteralsAndComments(text));
  if (POLICY_RE.test(masked) || ROW_LEVEL_SECURITY_RE.test(masked)) {
    return { text, key: masked };
  }
  if (!DO_RE.test(masked)) return undefined;
  const kept = normalise(stripSqlComments(text));
  return kept.includes('policy') && kept.includes(NOTES_TABLE)
    ? { text, key: kept }
    : undefined;
}

/** The statements that change the notes access rules, each with its original text and the key two versions compare by: a policy or row level security statement on notes, or a `do` block that mentions a policy and notes. */
export const accessRules = (sql: string): AccessRule[] =>
  splitStatements(sql).flatMap((text) => accessRule(text) ?? []);

/** The comparison keys of `accessRules`: comments and literals masked, whitespace squashed and lower-cased, except a `do` block keeps its body. */
export const accessRuleStatements = (sql: string): string[] =>
  accessRules(sql).map(({ key }) => key);

const SEEDED_ACCESS_RULES = accessRuleStatements(
  [
    `alter table public.${NOTES_TABLE} enable row level security`,
    ...SEEDED_NOTES_POLICIES,
  ]
    .map((statement) => `${statement};`)
    .join('\n')
);

const sameStatements = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((statement, i) => statement === b[i]);

async function readMigrationFile(
  ctx: ExecContext,
  file: string
): Promise<string> {
  const result = await ctx.exec(
    `cat ${shellQuote(`${MIGRATIONS_DIR}/${file}`)}`
  );
  if (!result.ok) {
    throw new Error(
      `could not read ${MIGRATIONS_DIR}/${file}: ${describeFailure(result)}`
    );
  }
  return result.stdout;
}

/** Finds the migrations that change the notes access rules: new ones after the seeded version, and the seeded file when its rules were edited; with the seeded file gone, also whether any migration still creates notes. */
export async function findPolicyMigrations(
  ctx: ExecContext
): Promise<PolicyMigrationsProbe> {
  try {
    const listing = await ctx.exec(`ls ${MIGRATIONS_DIR}`);
    if (!listing.ok) {
      return {
        ok: false,
        notes: `${MIGRATIONS_DIR} is not readable (${describeFailure(listing)})`,
      };
    }
    const migrations: PolicyMigration[] = [];
    const misordered: string[] = [];
    let createsNotes = false;
    const files = listing.stdout
      .split('\n')
      .map((line) => line.trim())
      .sort(compareText);
    for (const file of files) {
      const match = MIGRATION_FILENAME_RE.exec(file);
      if (match === null) continue;
      const [, version] = match;
      const sql = await readMigrationFile(ctx, file);
      createsNotes ||= migrationCreatesTable(sql, NOTES_TABLE);
      const rules = accessRuleStatements(sql);
      if (file === SEEDED_MIGRATION_FILE) {
        if (!sameStatements(rules, SEEDED_ACCESS_RULES)) {
          migrations.push({ version, file, seeded: true });
        }
      } else if (rules.length > 0) {
        if (version > SEEDED_MIGRATION_VERSION) {
          migrations.push({ version, file, seeded: false });
        } else {
          misordered.push(file);
        }
      }
    }
    migrations.sort(
      (a, b) => compareText(a.version, b.version) || compareText(a.file, b.file)
    );
    const seededMissing = !files.includes(SEEDED_MIGRATION_FILE);
    return {
      ok: true,
      migrations,
      misordered,
      ...(seededMissing ? { seededMissing: true as const } : {}),
      ...(seededMissing && !createsNotes
        ? { notesNeverCreated: true as const }
        : {}),
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export const describeMigrations = (migrations: readonly PolicyMigration[]) =>
  migrations
    .map(
      ({ file, version, seeded }) =>
        `${file} (version ${version}${seeded ? ', seeded file edited' : ''})`
    )
    .join(', ');

const versionList = (migrations: readonly PolicyMigration[]) =>
  `version(s) ${migrations.map(({ version }) => version).join(', ')}`;

export const describeMissingVersions = (missing: readonly PolicyMigration[]) =>
  `${versionList(missing)} not in supabase_migrations.schema_migrations`;

const sameRulesAs = (a: string, b: string) =>
  sameStatements(accessRuleStatements(a), accessRuleStatements(b));

/** Reads which of the migrations that change the notes access rules are in the CLI's migration history with the statements the files hold now. */
export async function readRecordedPolicyMigrations(
  ctx: ExecContext,
  stack: StackProbe,
  probe: PolicyMigrationsProbe
): Promise<RecordedPolicyMigrationsProbe> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  if (!probe.ok) return { ok: false, notes: probe.notes };
  const { migrations } = probe;
  if (migrations.length === 0) {
    return { ok: false, notes: 'no migration touches the notes policies' };
  }
  try {
    const versions = migrations.map(({ version }) => `'${version}'`).join(', ');
    const result = await ctx.exec(
      psqlCommand(stack.dbUrl, [
        `-c "select version || '|' || encode(convert_to(coalesce(array_to_string(statements, ';' || chr(10)), ''), 'UTF8'), 'hex') from supabase_migrations.schema_migrations where version in (${versions})"`,
      ])
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

    const recorded: PolicyMigration[] = [];
    const missing: PolicyMigration[] = [];
    const mismatched: PolicyMigration[] = [];
    for (const migration of migrations) {
      const statements = history.get(migration.version);
      if (statements === undefined) {
        missing.push(migration);
        continue;
      }
      const file = await readMigrationFile(ctx, migration.file);
      (sameRulesAs(statements, file) ? recorded : mismatched).push(migration);
    }
    return { ok: true, recorded, missing, mismatched };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

function fileAndHistoryProblems(
  found: PolicyMigrationsProbe,
  recorded: RecordedPolicyMigrationsProbe
): string[] {
  if (!found.ok) return [found.notes];
  const tableProblems = found.notesNeverCreated ? [NOTES_NEVER_CREATED] : [];
  if (found.migrations.length === 0 && found.misordered.length === 0) {
    return [
      ...tableProblems,
      'no migration changes the notes policies, so the fix is not in any migration',
    ];
  }
  const problems = [
    ...tableProblems,
    ...found.misordered.map(
      (file) =>
        `${file} sorts at or before ${SEEDED_MIGRATION_VERSION}, so a reset applies it before notes exists`
    ),
  ];
  if (found.migrations.length > 0) {
    if (!recorded.ok) {
      problems.push(recorded.notes);
    } else {
      if (recorded.missing.length > 0) {
        problems.push(describeMissingVersions(recorded.missing));
      }
      if (recorded.mismatched.length > 0) {
        problems.push(
          `${versionList(recorded.mismatched)} recorded with different notes policy statements than the file now holds, so the file changed after it was applied`
        );
      }
    }
  }
  return problems;
}

/** The SQL of the replay probe: one rolled-back transaction that clears the notes policies, applies `statements` in order, then runs the access probe. */
export function buildReplayProbeSql(statements: readonly string[]): string {
  return `begin;
${DROP_NOTES_POLICIES_SQL}
alter table public.${NOTES_TABLE} disable row level security;
alter table public.${NOTES_TABLE} no force row level security;
${statements.map((statement) => `${statement};`).join('\n')}
${buildAccessProbeBody()}
rollback;
`;
}

/** Replays the seeded file's notes access rules (when the file still exists) and then each contributing migration's, in version order, onto the live table in a rolled-back session, and probes what each user can then read and write; never throws. */
export async function readReplayedNotesAccess(
  ctx: ExecContext,
  stack: StackProbe,
  found: PolicyMigrationsProbe,
  recorded: RecordedPolicyMigrationsProbe
): Promise<AccessProbe> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  if (fileAndHistoryProblems(found, recorded).length > 0 || !found.ok) {
    return {
      ok: false,
      notes:
        'the migrations were not replayed because their files and history are not in order',
    };
  }
  try {
    const files = [
      ...(found.seededMissing ? [] : [SEEDED_MIGRATION_FILE]),
      ...found.migrations
        .filter(({ seeded }) => !seeded)
        .map(({ file }) => file),
    ];
    const statements: string[] = [];
    for (const file of files) {
      const rules = accessRules(await readMigrationFile(ctx, file));
      statements.push(...rules.map(({ text }) => text));
    }
    const result = await ctx.exec(
      psqlCommand(stack.dbUrl, ['-f -'], buildReplayProbeSql(statements))
    );
    if (!result.ok) return { ok: false, notes: describeFailure(result) };
    return parseAccessProbeOutput(result.stdout);
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

/** Passes when every migration that changes the notes access rules is recorded in the CLI's migration history with the rules the file holds now, and replaying them gives each user only their own notes. */
export function checkFixInAppliedMigration(
  found: PolicyMigrationsProbe,
  recorded: RecordedPolicyMigrationsProbe,
  replayed: AccessProbe
): CheckResult {
  const name = MIGRATION_CHECK_NAME;
  const problems = fileAndHistoryProblems(found, recorded);
  if (problems.length > 0) {
    return { name, passed: false, notes: problems.join('; ') };
  }
  const fromSeededState =
    found.ok && found.seededMissing ? '' : ' from the seeded state';
  if (!replayed.ok) {
    return {
      name,
      passed: false,
      notes: `the migrations could not be replayed${fromSeededState}: ${replayed.notes}`,
    };
  }
  const read = checkReadIsolation(replayed);
  const write = checkWriteIsolation(replayed);
  const failures = [
    ...(read.passed
      ? []
      : [
          `replaying the migrations does not give each user only their own notes, so a reset would not close the leak: ${read.notes}`,
        ]),
    ...(write.passed
      ? []
      : [
          `replaying the migrations does not leave writes owner-only, so a reset would not keep the fix: ${write.notes}`,
        ]),
  ];
  if (failures.length > 0) {
    return { name, passed: false, notes: failures.join('; ') };
  }
  const applied = recorded.ok ? recorded.recorded : [];
  return {
    name,
    passed: true,
    notes: `${describeMigrations(applied)} ${applied.length === 1 ? 'is' : 'are'} in supabase_migrations.schema_migrations, and replaying the migrations' notes policies${fromSeededState} leaves each user with only their own notes`,
  };
}
