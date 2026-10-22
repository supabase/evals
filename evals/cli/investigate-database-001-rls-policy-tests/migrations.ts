import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { maskSqlLiteralsAndComments } from '../lib/migrations.js';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';
import { psqlCommand } from './access.js';
import {
  NOTES_TABLE,
  SEEDED_MIGRATION_FILE,
  SEEDED_MIGRATION_VERSION,
  SEEDED_NOTES_POLICIES,
} from './fixtures.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type PolicyMigration = {
  version: string;
  file: string;
  seeded: boolean;
};
export type PolicyMigrationsProbe =
  | { ok: true; migrations: PolicyMigration[]; misordered: string[] }
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
const MIGRATION_FILENAME_RE = /^(\d+)_(.+)\.sql$/;
const HISTORY_ROW_RE = /^(\d+)\|((?:[0-9a-f]{2})*)$/i;
const NOTES = `(?:"?public"?\\s*\\.\\s*)?"?${NOTES_TABLE}"?(?![\\w$"])`;
const POLICY_RE = new RegExp(
  `^(?:create|alter|drop) policy (?:if exists )?(?:"(?:[^"]|"")*"|[^\\s"]+) on ${NOTES}`
);
const ROW_LEVEL_SECURITY_RE = new RegExp(
  `^alter table (?:if exists )?(?:only )?${NOTES}.*\\b(?:enable|disable|force|no force) row level security\\b`
);

const normalise = (statement: string) =>
  statement.replace(/\s+/g, ' ').trim().toLowerCase();

/** Normalised (comments and literals masked, whitespace squashed, lower-cased) `create|alter|drop policy … on [public.]notes` and `alter table … [public.]notes … row level security` statements, in order. */
export function accessRuleStatements(sql: string): string[] {
  return maskSqlLiteralsAndComments(sql)
    .split(';')
    .map(normalise)
    .filter(
      (statement) =>
        POLICY_RE.test(statement) || ROW_LEVEL_SECURITY_RE.test(statement)
    );
}

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

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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

/** Finds the migrations that change the notes access rules: new ones after the seeded version, and the seeded file when its rules were edited. */
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
    const files = listing.stdout
      .split('\n')
      .map((line) => line.trim())
      .sort(compareText);
    for (const file of files) {
      const match = MIGRATION_FILENAME_RE.exec(file);
      if (match === null) continue;
      const [, version] = match;
      const rules = accessRuleStatements(await readMigrationFile(ctx, file));
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
    return { ok: true, migrations, misordered };
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

/** Passes when every migration that changes the notes access rules is recorded in the CLI's migration history with the rules the file holds now. */
export function checkFixInAppliedMigration(
  found: PolicyMigrationsProbe,
  recorded: RecordedPolicyMigrationsProbe
): CheckResult {
  const name = MIGRATION_CHECK_NAME;
  if (!found.ok) return { name, passed: false, notes: found.notes };
  if (found.migrations.length === 0 && found.misordered.length === 0) {
    return {
      name,
      passed: false,
      notes:
        'no migration changes the notes policies, so the fix is not in any migration',
    };
  }
  const problems = found.misordered.map(
    (file) =>
      `${file} sorts at or before ${SEEDED_MIGRATION_VERSION}, so a reset applies it before notes exists`
  );
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
  if (problems.length > 0) {
    return { name, passed: false, notes: problems.join('; ') };
  }
  const applied = recorded.ok ? recorded.recorded : [];
  return {
    name,
    passed: true,
    notes: `${describeMigrations(applied)} ${applied.length === 1 ? 'is' : 'are'} in supabase_migrations.schema_migrations`,
  };
}
