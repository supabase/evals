import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { describeFailure, errorMessage, shellQuote } from '../lib/shell.js';
import {
  MIGRATIONS_DIR,
  readSeedFile,
  SEEDED_MIGRATIONS,
  SEEDED_TEST_FILES,
  SEEDED_TESTS,
  TESTS_DIR,
} from './fixtures.js';
import { sqlFingerprint } from './sql.js';

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

const MIGRATION_FILE_RE = /^(\d+)_(.+)\.sql$/;
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

/** Passes when every seeded test file is still there and holds the same statements, ignoring comments and whitespace. */
export function checkSeededTestsUnchanged(probe: WorkspaceProbe): CheckResult {
  const name = TESTS_UNCHANGED_CHECK;
  if (!probe.ok) return { name, passed: false, notes: probe.notes };
  const modified: string[] = [];
  const missing: string[] = [];
  for (const seeded of SEEDED_TESTS) {
    const sql =
      probe.seededTests.find(({ file }) => file === seeded.file)?.sql ?? null;
    if (sql === null) missing.push(seeded.file);
    else if (sqlFingerprint(sql) !== sqlFingerprint(seeded.sql)) {
      modified.push(seeded.file);
    }
  }
  if (modified.length === 0 && missing.length === 0) {
    return {
      name,
      passed: true,
      notes: `${SEEDED_TESTS.length} seeded test files unchanged`,
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
