// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-006-fix-failing-pgtap-suite
import type { LocalStackEnvironmentMarker } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import type { PgProveSummary, TestDbRun } from '../lib/pgtap.js';
import type { StackProbe } from '../lib/stack.js';
import {
  readSeedFile,
  SEEDED_MIGRATIONS,
  SEEDED_TEST_FILES,
  SEEDED_TESTS,
} from './fixtures.js';
import { checkMetrics } from './metrics.js';
import type { MigrationFile, WorkspaceProbe } from './workspace.js';

type Facts = Parameters<typeof checkMetrics>[1];

const DB_URL = 'postgresql://postgres:hunter2@127.0.0.1:54322/postgres';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.0.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  runtime: 'native',
  dbUrl: DB_URL,
};

const KEYS = [
  'cliVersion',
  'cliOverride',
  'channel',
  'backend',
  'runtime',
  'relocatedHome',
  'dbPort',
  'testDbRuns',
  'testDbResults',
  'testDbFailedFirst',
  'resetRuns',
  'migrationUpRuns',
  'pgProveDirect',
  'newMigrationFiles',
  'seededMigrationsModified',
  'seededMigrationsMissing',
  'testFiles',
  'cliDetours',
];

const seededFiles = (): MigrationFile[] =>
  SEEDED_MIGRATIONS.map((name) => ({
    name,
    version: name.slice(0, 14),
    sql: readSeedFile(`supabase/migrations/${name}`),
  }));

const workspaceOf = (
  migrations: MigrationFile[] = seededFiles(),
  testFiles: string[] = [...SEEDED_TEST_FILES]
): WorkspaceProbe => ({
  ok: true,
  migrations,
  seededTests: SEEDED_TESTS.map(({ file, sql }) => ({ file, sql })),
  testFiles,
});

const PASS_SUMMARY: PgProveSummary = { result: 'PASS', files: 2, tests: 9 };
const FAIL_SUMMARY: PgProveSummary = { result: 'FAIL', files: 2, tests: 6 };

const PASS_RUN: TestDbRun = {
  commandIndex: 3,
  summary: PASS_SUMMARY,
  summaries: [PASS_SUMMARY],
};

const facts = (overrides: Partial<Facts> = {}): Facts => ({
  commands: [],
  invocations: [],
  stack: STACK,
  cli: { versions: { cliVersion: '2.0.0' }, cliOverride: [] },
  workspace: workspaceOf(),
  testDbRuns: [],
  ...overrides,
});

const ran = (...commands: string[]): Partial<Facts> => ({
  commands,
  invocations: findSupabaseInvocations(commands),
});

const metricsFor = async (
  marker: LocalStackEnvironmentMarker | undefined,
  overrides: Partial<Facts> = {}
) => {
  const check = await checkMetrics(marker, facts(overrides));
  return { check, metrics: JSON.parse(check.notes ?? 'null') };
};

const metricsOf = async (overrides: Partial<Facts> = {}) =>
  (await metricsFor(MARKER, overrides)).metrics;

const throwing = <T extends object>(target: T): T =>
  new Proxy(target, {
    get() {
      throw new Error('boom');
    },
  });

describe('checkMetrics', () => {
  it('is named metrics, always passes, and carries every field as JSON notes', async () => {
    const { check, metrics } = await metricsFor(MARKER, {
      testDbRuns: [PASS_RUN],
    });
    expect(check).toMatchObject({ name: 'metrics', passed: true });
    for (const key of KEYS) expect(metrics).toHaveProperty(key);
  });

  it('reports the facts of an untouched run', async () => {
    expect(await metricsOf()).toMatchObject({
      cliVersion: '2.0.0',
      cliOverride: [],
      channel: 'beta',
      backend: 'managed',
      runtime: 'native',
      relocatedHome: null,
      dbPort: 54322,
      testDbRuns: 0,
      testDbResults: [],
      testDbFailedFirst: null,
      resetRuns: 0,
      migrationUpRuns: 0,
      pgProveDirect: 0,
      newMigrationFiles: 0,
      seededMigrationsModified: 0,
      seededMigrationsMissing: 0,
      testFiles: 2,
      cliDetours: 0,
    });
  });

  it('still passes, reporting null or none, when the stack, the workspace and the CLI facts are all unavailable', async () => {
    const { check, metrics } = await metricsFor(undefined, {
      stack: { ok: false, notes: 'managed: exit 1: no stack running' },
      workspace: { ok: false, notes: 'supabase/migrations is missing' },
      cli: { versions: null, cliOverride: null },
    });
    expect(check.passed).toBe(true);
    expect(metrics).toMatchObject({
      cliVersion: null,
      cliOverride: null,
      channel: 'pinned',
      backend: 'none',
      runtime: 'none',
      relocatedHome: null,
      dbPort: null,
      newMigrationFiles: null,
      seededMigrationsModified: null,
      seededMigrationsMissing: null,
      testFiles: null,
    });
  });

  it('never records the stack credentials', async () => {
    const check = await checkMetrics(MARKER, facts());
    expect(check.notes).not.toContain('hunter2');
  });

  describe('supabase test db runs', () => {
    it('counts the runs and lists their results in order, null for a run that printed no summary', async () => {
      const metrics = await metricsOf({
        testDbRuns: [
          { commandIndex: 0, summary: null, summaries: [], withPgProve: true },
          {
            commandIndex: 1,
            summary: FAIL_SUMMARY,
            summaries: [FAIL_SUMMARY],
          },
          PASS_RUN,
        ],
      });
      expect(metrics).toMatchObject({
        testDbRuns: 3,
        testDbResults: [null, 'FAIL', 'PASS'],
      });
    });

    it('lists a null result for a summary that has no Result line', async () => {
      const metrics = await metricsOf({
        testDbRuns: [
          {
            commandIndex: 0,
            summary: { result: null, files: 2, tests: 9 },
            summaries: [{ result: null, files: 2, tests: 9 }],
          },
        ],
      });
      expect(metrics.testDbResults).toEqual([null]);
    });

    const FAIL_RUN: TestDbRun = {
      commandIndex: 1,
      summary: FAIL_SUMMARY,
      summaries: [FAIL_SUMMARY],
    };

    it('records testDbFailedFirst as true when the first run with a summary printed FAIL', async () => {
      const metrics = await metricsOf({
        testDbRuns: [
          { commandIndex: 0, summary: null, summaries: [] },
          FAIL_RUN,
          PASS_RUN,
        ],
      });
      expect(metrics.testDbFailedFirst).toBe(true);
    });

    it('records testDbFailedFirst as true for one call that printed FAIL and then PASS, while testDbResults lists the last summary', async () => {
      const metrics = await metricsOf({
        testDbRuns: [
          {
            commandIndex: 0,
            summary: PASS_SUMMARY,
            summaries: [FAIL_SUMMARY, PASS_SUMMARY],
          },
        ],
      });
      expect(metrics).toMatchObject({
        testDbResults: ['PASS'],
        testDbFailedFirst: true,
      });
    });

    it('records testDbFailedFirst as false for one call that printed PASS and then FAIL', async () => {
      const metrics = await metricsOf({
        testDbRuns: [
          {
            commandIndex: 0,
            summary: FAIL_SUMMARY,
            summaries: [PASS_SUMMARY, FAIL_SUMMARY],
          },
        ],
      });
      expect(metrics.testDbFailedFirst).toBe(false);
    });

    it('skips a summary with no Result line within a call when finding the first result', async () => {
      const metrics = await metricsOf({
        testDbRuns: [
          {
            commandIndex: 0,
            summary: PASS_SUMMARY,
            summaries: [
              { result: null, files: 0, tests: 0 },
              FAIL_SUMMARY,
              PASS_SUMMARY,
            ],
          },
        ],
      });
      expect(metrics.testDbFailedFirst).toBe(true);
    });

    it('records testDbFailedFirst as false when the first run with a summary printed PASS', async () => {
      const metrics = await metricsOf({
        testDbRuns: [PASS_RUN, { ...FAIL_RUN, commandIndex: 4 }],
      });
      expect(metrics.testDbFailedFirst).toBe(false);
    });

    it('records testDbFailedFirst as null when no run printed a summary or a result line', async () => {
      expect(await metricsOf({ testDbRuns: [] })).toMatchObject({
        testDbFailedFirst: null,
      });
      expect(
        await metricsOf({
          testDbRuns: [
            {
              commandIndex: 0,
              summary: null,
              summaries: [],
              withPgProve: true,
            },
            {
              commandIndex: 1,
              summary: { result: null, files: 2, tests: 9 },
              summaries: [{ result: null, files: 2, tests: 9 }],
            },
          ],
        })
      ).toMatchObject({ testDbFailedFirst: null });
    });
  });

  describe('command counts', () => {
    it('counts db resets and migration ups the agent ran', async () => {
      const metrics = await metricsOf(
        ran(
          'supabase start',
          'supabase db reset',
          'supabase db reset --local',
          'npx supabase db reset',
          'supabase migration up',
          'supabase migration up --local',
          'supabase test db',
          'supabase migration list',
          'echo supabase db reset',
          'psql "$DATABASE_URL" -c "select 1"'
        )
      );
      expect(metrics).toMatchObject({ resetRuns: 3, migrationUpRuns: 2 });
    });

    it('keeps a reset in a compound command', async () => {
      const metrics = await metricsOf(
        ran('supabase db reset && supabase test db')
      );
      expect(metrics.resetRuns).toBe(1);
    });

    it('counts pg_prove run by hand, not supabase test db or text that mentions it', async () => {
      const metrics = await metricsOf(
        ran(
          'pg_prove -d postgresql://postgres:postgres@127.0.0.1:54322/postgres supabase/tests',
          'pg_prove -r supabase/tests',
          'echo pg_prove',
          'supabase test db',
          'cat supabase/tests/invoice_totals.test.sql',
          'psql -f supabase/tests/invoice_totals.test.sql'
        )
      );
      expect(metrics.pgProveDirect).toBe(2);
    });

    it('counts the container-runtime detours', async () => {
      const metrics = await metricsOf(ran('sudo dockerd', 'supabase start'));
      expect(metrics.cliDetours).toBe(1);
    });

    it('reports zero for each count when the agent ran nothing', async () => {
      expect(await metricsOf(ran())).toMatchObject({
        resetRuns: 0,
        migrationUpRuns: 0,
        pgProveDirect: 0,
        cliDetours: 0,
      });
    });
  });

  describe('migration files', () => {
    it('counts migration files beside the seeded ones', async () => {
      const migrations = [
        ...seededFiles(),
        {
          name: '20260302000000_fix.sql',
          version: '20260302000000',
          sql: 'select 1;',
        },
        {
          name: '20260303000000_more.sql',
          version: '20260303000000',
          sql: 'select 2;',
        },
      ];
      expect(
        await metricsOf({ workspace: workspaceOf(migrations) })
      ).toMatchObject({
        newMigrationFiles: 2,
        seededMigrationsModified: 0,
        seededMigrationsMissing: 0,
      });
    });

    it('counts a seeded migration whose statements changed as modified', async () => {
      const [first, second] = seededFiles();
      const migrations = [
        first,
        {
          ...second,
          sql: second.sql.replace('not null', 'not null default 0'),
        },
      ];
      expect(
        await metricsOf({ workspace: workspaceOf(migrations) })
      ).toMatchObject({
        newMigrationFiles: 0,
        seededMigrationsModified: 1,
        seededMigrationsMissing: 0,
      });
    });

    it('does not count added comments or whitespace as a modification', async () => {
      const migrations = seededFiles().map((file) => ({
        ...file,
        sql: `-- reviewed\n\n${file.sql}\n\n`,
      }));
      expect(
        (await metricsOf({ workspace: workspaceOf(migrations) }))
          .seededMigrationsModified
      ).toBe(0);
    });

    it('counts a seeded migration that is gone as missing, not modified', async () => {
      const [first] = seededFiles();
      expect(
        await metricsOf({ workspace: workspaceOf([first]) })
      ).toMatchObject({
        newMigrationFiles: 0,
        seededMigrationsModified: 0,
        seededMigrationsMissing: 1,
      });
    });
  });

  describe('test files', () => {
    it('counts every test file under supabase/tests, extras included', async () => {
      const testFiles = [...SEEDED_TEST_FILES, 'rounding.test.sql'];
      expect(
        (await metricsOf({ workspace: workspaceOf(seededFiles(), testFiles) }))
          .testFiles
      ).toBe(3);
    });

    it('counts none when the tests directory is gone', async () => {
      expect(
        (await metricsOf({ workspace: workspaceOf(seededFiles(), []) }))
          .testFiles
      ).toBe(0);
    });
  });

  describe('stack and CLI', () => {
    it('records the stack backend, runtime and database port', async () => {
      expect(await metricsOf()).toMatchObject({
        backend: 'managed',
        runtime: 'native',
        dbPort: 54322,
        relocatedHome: null,
      });
    });

    it('records a relocated CLI home', async () => {
      const stack: StackProbe = {
        ...STACK,
        relocatedHome: '/tmp/agent/.supabase',
      };
      expect((await metricsOf({ stack })).relocatedHome).toBe(
        '/tmp/agent/.supabase'
      );
    });

    it('records the installed CLI, the PATH version after the run and the runners the agent used', async () => {
      expect(
        await metricsOf({
          cli: {
            versions: { cliVersion: '2.117.0', cliVersionAfterRun: '2.120.0' },
            cliOverride: ['npx --yes supabase@2.120.0'],
          },
        })
      ).toMatchObject({
        cliVersion: '2.117.0',
        cliVersionAfterRun: '2.120.0',
        cliOverride: ['npx --yes supabase@2.120.0'],
      });
    });

    it('omits cliVersionAfterRun when the PATH version did not change', async () => {
      expect(await metricsOf()).not.toHaveProperty('cliVersionAfterRun');
    });

    it('reports the marker channel, or pinned without a marker', async () => {
      expect((await metricsFor(MARKER)).metrics.channel).toBe('beta');
      expect((await metricsFor(undefined)).metrics.channel).toBe('pinned');
    });
  });

  describe('one field failing does not blank the others', () => {
    it('keeps every other field when the invocations cannot be read', async () => {
      const { check, metrics } = await metricsFor(MARKER, {
        commands: ['pg_prove -r supabase/tests', 'sudo dockerd'],
        invocations: throwing([]),
        testDbRuns: [PASS_RUN],
      });
      expect(check.passed).toBe(true);
      expect(metrics).toMatchObject({
        resetRuns: null,
        migrationUpRuns: null,
        pgProveDirect: 1,
        cliDetours: 1,
        testDbRuns: 1,
        testDbResults: ['PASS'],
        newMigrationFiles: 0,
        testFiles: 2,
        backend: 'managed',
        dbPort: 54322,
        cliVersion: '2.0.0',
      });
    });

    it('keeps every other field when the commands cannot be read', async () => {
      const { check, metrics } = await metricsFor(MARKER, {
        commands: throwing([]),
        invocations: findSupabaseInvocations([
          'supabase db reset',
          'supabase migration up',
        ]),
        testDbRuns: [PASS_RUN],
      });
      expect(check.passed).toBe(true);
      expect(metrics).toMatchObject({
        pgProveDirect: null,
        cliDetours: null,
        resetRuns: 1,
        migrationUpRuns: 1,
        testDbRuns: 1,
        newMigrationFiles: 0,
        testFiles: 2,
        backend: 'managed',
        cliVersion: '2.0.0',
      });
    });

    it('keeps every other field when the workspace cannot be read', async () => {
      const { check, metrics } = await metricsFor(MARKER, {
        ...ran('supabase db reset', 'pg_prove -r supabase/tests'),
        workspace: throwing({ ok: true }) as WorkspaceProbe,
        testDbRuns: [PASS_RUN],
      });
      expect(check.passed).toBe(true);
      expect(metrics).toMatchObject({
        newMigrationFiles: null,
        seededMigrationsModified: null,
        seededMigrationsMissing: null,
        testFiles: null,
        resetRuns: 1,
        pgProveDirect: 1,
        testDbRuns: 1,
        backend: 'managed',
        cliVersion: '2.0.0',
      });
    });
  });
});
