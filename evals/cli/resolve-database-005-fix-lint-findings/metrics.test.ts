// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-005-fix-lint-findings
import type { LocalStackEnvironmentMarker } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import type { StackProbe } from '../lib/stack.js';
import { countDatabaseCheckRuns } from './commands.js';
import { readSeedFile, SEEDED_MIGRATIONS } from './fixtures.js';
import { checkMetrics } from './metrics.js';
import type { ProbeReport } from './probe.js';

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

const seededFiles = () =>
  SEEDED_MIGRATIONS.map((name) => ({
    name,
    sql: readSeedFile(`supabase/migrations/${name}`),
  }));

const PROBE_REPORT: ProbeReport = {
  live: {
    advisors: [
      { name: 'rls_disabled_in_public', object: 'public.order_items' },
      { name: 'policy_exists_rls_disabled', object: 'public.order_items' },
      { name: 'function_search_path_mutable', object: 'set_updated_at()' },
    ],
    advisorsDone: true,
    lint: [
      {
        function: 'order_total(bigint)',
        level: 'error',
        message: 'column oi.price does not exist',
      },
      {
        function: 'other(int)',
        level: 'warning extra',
        message: 'unused parameter',
      },
    ],
    lintDone: true,
    readers: [],
  },
  replay: { ok: true, files: 4 },
  replayed: {
    advisors: [],
    advisorsDone: true,
    lint: [],
    lintDone: true,
    readers: [],
  },
  unparsed: [],
};

const facts = (overrides: Partial<Facts> = {}): Facts => ({
  commands: [],
  invocations: [],
  counts: { lint: 0, advisors: 0 },
  stack: STACK,
  cli: { versions: { cliVersion: '2.0.0' }, cliOverride: [] },
  migrations: { ok: true, migrations: seededFiles() },
  probe: { ok: true, report: PROBE_REPORT },
  ...overrides,
});

const ran = (...commands: string[]): Partial<Facts> => {
  const invocations = findSupabaseInvocations(commands);
  return {
    commands,
    invocations,
    counts: countDatabaseCheckRuns(invocations),
  };
};

const metricsFor = async (
  marker: LocalStackEnvironmentMarker | undefined,
  overrides: Partial<Facts> = {}
) => {
  const check = await checkMetrics(marker, facts(overrides));
  return JSON.parse(check.notes ?? 'null');
};

const metricsOf = (overrides: Partial<Facts> = {}) =>
  metricsFor(MARKER, overrides);

describe('checkMetrics', () => {
  it('passes and names itself metrics, with the metrics as JSON notes', async () => {
    const check = await checkMetrics(MARKER, facts());
    expect(check.name).toBe('metrics');
    expect(check.passed).toBe(true);
    expect(JSON.parse(check.notes ?? 'null')).toMatchObject({
      cliVersion: '2.0.0',
      channel: 'beta',
    });
  });

  it('still passes when the stack, the probe, the workspace and the CLI facts are all unavailable', async () => {
    const check = await checkMetrics(
      undefined,
      facts({
        stack: { ok: false, notes: 'managed: exit 1: no stack running' },
        probe: { ok: false, notes: 'exit 2: connection refused' },
        migrations: { ok: false, notes: 'supabase/migrations is missing' },
        cli: { versions: null, cliOverride: null },
      })
    );
    expect(check.passed).toBe(true);
    expect(JSON.parse(check.notes ?? '')).toMatchObject({
      cliVersion: null,
      cliOverride: null,
      channel: 'pinned',
      stackBackend: null,
      stackRuntime: null,
      dbPort: null,
      newMigrationFiles: null,
      seededMigrationsModified: null,
      seededMigrationsMissing: null,
      liveLintIssues: null,
      liveAdvisorFindings: null,
      probeUnparsedLines: null,
    });
  });

  describe('command counts', () => {
    it('counts the database checks, resets, migration ups, db queries and psql commands the agent ran', async () => {
      const metrics = await metricsOf(
        ran(
          'supabase db lint',
          'supabase db lint --level error',
          'npx supabase db advisors --local',
          'supabase db reset',
          'supabase db reset --local',
          'supabase migration up',
          'supabase migration up --local',
          'supabase db query "select 1"',
          'psql "$DATABASE_URL" -c "select 1"',
          'psql a -c x && psql b -c y',
          'docker exec db psql -U postgres',
          'echo psql'
        )
      );
      expect(metrics).toMatchObject({
        lintRuns: 2,
        advisorsRuns: 1,
        resetRuns: 2,
        migrationUpRuns: 2,
        dbQueryRuns: 1,
        psqlCommands: 3,
      });
    });

    it('reports the database check counts it is given instead of recounting the invocations', async () => {
      expect(
        await metricsOf({ counts: { lint: 5, advisors: 6 } })
      ).toMatchObject({ lintRuns: 5, advisorsRuns: 6 });
    });

    it('reports zero for each count when the agent ran nothing', async () => {
      expect(await metricsOf(ran())).toMatchObject({
        lintRuns: 0,
        advisorsRuns: 0,
        resetRuns: 0,
        migrationUpRuns: 0,
        dbQueryRuns: 0,
        psqlCommands: 0,
      });
    });
  });

  describe('migration files', () => {
    it('reports an untouched project', async () => {
      expect(await metricsOf()).toMatchObject({
        newMigrationFiles: 0,
        seededMigrationsModified: 0,
        seededMigrationsMissing: 0,
      });
    });

    it('counts migration files beside the seeded ones', async () => {
      const migrations: Facts['migrations'] = {
        ok: true,
        migrations: [
          ...seededFiles(),
          { name: '20261022000000_fix.sql', sql: 'select 1;' },
          { name: '20261023000000_more.sql', sql: 'select 2;' },
        ],
      };
      expect(await metricsOf({ migrations })).toMatchObject({
        newMigrationFiles: 2,
        seededMigrationsModified: 0,
        seededMigrationsMissing: 0,
      });
    });

    it('does not count the seed file as a new migration', async () => {
      const migrations: Facts['migrations'] = {
        ok: true,
        migrations: seededFiles(),
        seed: {
          name: 'seed.sql',
          sql: 'insert into public.orders values (1);',
        },
      };
      expect((await metricsOf({ migrations })).newMigrationFiles).toBe(0);
    });

    it('counts a seeded migration whose content changed', async () => {
      const [first, second, third] = seededFiles();
      const migrations: Facts['migrations'] = {
        ok: true,
        migrations: [
          first,
          second,
          { ...third, sql: `${third.sql}\nselect 1;\n` },
        ],
      };
      expect(await metricsOf({ migrations })).toMatchObject({
        newMigrationFiles: 0,
        seededMigrationsModified: 1,
        seededMigrationsMissing: 0,
      });
    });

    it('ignores whitespace around a seeded migration, as the file read adds a trailing newline', async () => {
      const migrations: Facts['migrations'] = {
        ok: true,
        migrations: seededFiles().map((file) => ({
          ...file,
          sql: `\n${file.sql.trim()}\n\n`,
        })),
      };
      expect((await metricsOf({ migrations })).seededMigrationsModified).toBe(
        0
      );
    });

    it('counts a seeded migration that is gone as missing, not modified', async () => {
      const [first, , third] = seededFiles();
      const migrations: Facts['migrations'] = {
        ok: true,
        migrations: [first, third],
      };
      expect(await metricsOf({ migrations })).toMatchObject({
        newMigrationFiles: 0,
        seededMigrationsModified: 0,
        seededMigrationsMissing: 1,
      });
    });

    it('is null for all three when the workspace could not be read', async () => {
      const metrics = await metricsOf({
        migrations: { ok: false, notes: 'exit 2: no such directory' },
      });
      expect(metrics.newMigrationFiles).toBeNull();
      expect(metrics.seededMigrationsModified).toBeNull();
      expect(metrics.seededMigrationsMissing).toBeNull();
    });
  });

  describe('live findings', () => {
    it('counts the lint issues and advisor findings the probe saw in the live database', async () => {
      expect(await metricsOf()).toMatchObject({
        liveLintIssues: 2,
        liveAdvisorFindings: 3,
      });
    });

    it('is zero for a clean live database', async () => {
      const clean: ProbeReport = {
        ...PROBE_REPORT,
        live: { ...PROBE_REPORT.live, advisors: [], lint: [] },
      };
      expect(
        await metricsOf({ probe: { ok: true, report: clean } })
      ).toMatchObject({ liveLintIssues: 0, liveAdvisorFindings: 0 });
    });

    it('is null for both when the probe failed', async () => {
      const metrics = await metricsOf({
        probe: { ok: false, notes: 'exit 2: connection refused' },
      });
      expect(metrics.liveLintIssues).toBeNull();
      expect(metrics.liveAdvisorFindings).toBeNull();
    });
  });

  describe('probe output', () => {
    const withUnparsed = (unparsed: string[]): Partial<Facts> => ({
      probe: { ok: true, report: { ...PROBE_REPORT, unparsed } },
    });

    it('counts the lines the probe printed that were not rows', async () => {
      expect(
        (await metricsOf(withUnparsed(['NOTICE: x', '{not json'])))
          .probeUnparsedLines
      ).toBe(2);
    });

    it('is zero when every line parsed', async () => {
      expect((await metricsOf()).probeUnparsedLines).toBe(0);
    });

    it('is null when the probe failed', async () => {
      const metrics = await metricsOf({
        probe: { ok: false, notes: 'exit 2: connection refused' },
      });
      expect(metrics.probeUnparsedLines).toBeNull();
    });
  });

  describe('stack and CLI', () => {
    it('records the stack backend, runtime and database port', async () => {
      expect(await metricsOf()).toMatchObject({
        stackBackend: 'managed',
        stackRuntime: 'native',
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

    it('never records the stack credentials', async () => {
      const check = await checkMetrics(MARKER, facts());
      expect(check.notes).not.toContain('hunter2');
    });

    it('records the installed CLI, the PATH version after the run and the runners the agent used', async () => {
      const metrics = await metricsOf({
        cli: {
          versions: { cliVersion: '2.117.0', cliVersionAfterRun: '2.120.0' },
          cliOverride: ['npx --yes supabase@2.120.0'],
        },
      });
      expect(metrics).toMatchObject({
        cliVersion: '2.117.0',
        cliVersionAfterRun: '2.120.0',
        cliOverride: ['npx --yes supabase@2.120.0'],
      });
    });

    it('omits cliVersionAfterRun when the PATH version did not change', async () => {
      expect(await metricsOf()).not.toHaveProperty('cliVersionAfterRun');
    });

    it('reports the marker channel, or pinned without a marker', async () => {
      expect((await metricsFor(MARKER)).channel).toBe('beta');
      expect((await metricsFor(undefined)).channel).toBe('pinned');
    });
  });
});
