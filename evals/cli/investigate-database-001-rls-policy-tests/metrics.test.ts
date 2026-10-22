// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-001-rls-policy-tests
import type { LocalStackEnvironmentMarker } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import type { StackProbe } from '../lib/stack.js';
import { checkMetrics } from './metrics.js';
import type { PolicyMigration } from './migrations.js';
import type { SuiteProbe, TapResult, TestFileRun } from './pgtap.js';
import type { TestDbRun } from './test-db-runs.js';

type Facts = Parameters<typeof checkMetrics>[1];

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: 'postgresql://postgres:hunter2@127.0.0.1:54322/postgres',
  runtime: 'native',
};

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.0.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

const A = 'supabase/tests/a_test.sql';
const B = 'supabase/tests/b_test.sql';
const FIX: PolicyMigration = {
  version: '20260102000000',
  file: '20260102000000_fix_notes_policy.sql',
  seeded: false,
};
const SEEDED: PolicyMigration = {
  version: '20260101000000',
  file: '20260101000000_create_notes.sql',
  seeded: true,
};

const KEYS = [
  'cliVersion',
  'cliOverride',
  'channel',
  'backend',
  'runtime',
  'relocatedHome',
  'dbPort',
  'testFiles',
  'testsPlanned',
  'testsPassedClean',
  'catchingFiles',
  'testDbRuns',
  'testDbResults',
  'directPolicyDdl',
  'pgProveDirect',
  'seededMigrationModified',
  'newMigrationFiles',
  'cliDetours',
];

const tapOf = (count: number, failing: readonly number[] = []): TapResult => ({
  planned: count,
  plans: 1,
  results: Array.from({ length: count }, (_, i) => ({
    ok: !failing.includes(i + 1),
    number: i + 1,
    description: `test ${i + 1}`,
    todo: false,
  })),
});

const run = (
  file: string,
  count = 3,
  failing: readonly number[] = []
): TestFileRun => ({
  file,
  passed: failing.length === 0,
  exitCode: 0,
  tap: tapOf(count, failing),
  detail: 'psql exit 0',
});

const mutated = (
  file: string,
  failing: readonly number[],
  mutationApplied = true
) => ({ ...run(file, 3, failing), mutationApplied });

const SUITE: SuiteProbe = {
  ok: true,
  files: [A],
  clean: [run(A)],
  catches: [{ file: A, mutated: mutated(A, [2]), rerun: run(A) }],
};

const PASS_RUN: TestDbRun = {
  commandIndex: 2,
  summary: { result: 'PASS', tests: 3 },
};

const COMMANDS = [
  'supabase start',
  'cat > supabase/migrations/20260102000000_fix_notes_policy.sql <<\'EOF\'\ndrop policy "Enable read access for authenticated users" on public.notes;\nEOF',
  'supabase test db',
];

const facts = (overrides: Partial<Facts> = {}): Facts => ({
  commands: COMMANDS,
  invocations: findSupabaseInvocations(COMMANDS),
  stack: STACK,
  cli: { versions: { cliVersion: '2.0.0' }, cliOverride: [] },
  migrations: { ok: true, migrations: [FIX], misordered: [] },
  suite: SUITE,
  testDbRuns: [PASS_RUN],
  ...overrides,
});

const metricsOf = async (
  overrides: Partial<Facts> = {},
  marker: LocalStackEnvironmentMarker | null = MARKER
) => {
  const check = await checkMetrics(marker ?? undefined, facts(overrides));
  return { check, metrics: JSON.parse(check.notes ?? '{}') };
};

describe('checkMetrics', () => {
  it('is named metrics and always passes', async () => {
    const { check } = await metricsOf();
    expect(check).toMatchObject({ name: 'metrics', passed: true });
  });

  it('reports the facts of a finished run as JSON', async () => {
    const { metrics } = await metricsOf();
    for (const key of KEYS) expect(metrics).toHaveProperty(key);
    expect(metrics).toMatchObject({
      cliVersion: '2.0.0',
      cliOverride: [],
      channel: 'beta',
      backend: 'managed',
      runtime: 'native',
      relocatedHome: null,
      dbPort: 54322,
      testFiles: 1,
      testsPlanned: 3,
      testsPassedClean: 3,
      catchingFiles: 1,
      testDbRuns: 1,
      testDbResults: ['PASS'],
      directPolicyDdl: 0,
      pgProveDirect: 0,
      seededMigrationModified: false,
      newMigrationFiles: 1,
      cliDetours: 0,
    });
  });

  it('reports the CLI version after the run and the override runners the agent used', async () => {
    const { metrics } = await metricsOf({
      cli: {
        versions: { cliVersion: '2.0.0', cliVersionAfterRun: '2.1.0' },
        cliOverride: ['npx --yes supabase@2.1.0'],
      },
    });
    expect(metrics).toMatchObject({
      cliVersion: '2.0.0',
      cliVersionAfterRun: '2.1.0',
      cliOverride: ['npx --yes supabase@2.1.0'],
    });
  });

  it('reports the channel as pinned without a marker', async () => {
    const { metrics } = await metricsOf({}, null);
    expect(metrics.channel).toBe('pinned');
  });

  it('reports the relocated home and the database port of the resolved stack', async () => {
    const { metrics } = await metricsOf({
      stack: {
        ok: true,
        backend: 'managed-named',
        dbUrl: 'postgresql://postgres:postgres@127.0.0.1:54399/postgres',
        runtime: 'docker',
        relocatedHome: '/home/agent/.supabase-local',
      },
    });
    expect(metrics).toMatchObject({
      backend: 'managed-named',
      runtime: 'docker',
      relocatedHome: '/home/agent/.supabase-local',
      dbPort: 54399,
    });
  });

  it('counts the planned and passing tests across every clean run', async () => {
    const { metrics } = await metricsOf({
      suite: {
        ok: true,
        files: [A, B],
        clean: [run(A, 3), run(B, 3, [1])],
        catches: [],
      },
    });
    expect(metrics).toMatchObject({
      testFiles: 2,
      testsPlanned: 6,
      testsPassedClean: 5,
      catchingFiles: 0,
    });
  });

  it('counts only the files that caught the mutation with its marker and passed the re-run', async () => {
    const { metrics } = await metricsOf({
      suite: {
        ok: true,
        files: [A, B, 'supabase/tests/c_test.sql', 'supabase/tests/d_test.sql'],
        clean: [
          A,
          B,
          'supabase/tests/c_test.sql',
          'supabase/tests/d_test.sql',
        ].map((file) => run(file)),
        catches: [
          { file: A, mutated: mutated(A, [2]), rerun: run(A) },
          { file: B, mutated: mutated(B, []), rerun: run(B) },
          {
            file: 'supabase/tests/c_test.sql',
            mutated: mutated('supabase/tests/c_test.sql', [2], false),
            rerun: run('supabase/tests/c_test.sql'),
          },
          {
            file: 'supabase/tests/d_test.sql',
            mutated: mutated('supabase/tests/d_test.sql', [2]),
            rerun: run('supabase/tests/d_test.sql', 3, [1]),
          },
        ],
      },
    });
    expect(metrics.catchingFiles).toBe(1);
  });

  it('lists the test db results in order, null for a run without a summary', async () => {
    const { metrics } = await metricsOf({
      testDbRuns: [
        { commandIndex: 0, summary: null },
        { commandIndex: 1, summary: { result: 'FAIL', tests: 1 } },
        PASS_RUN,
      ],
    });
    expect(metrics).toMatchObject({
      testDbRuns: 3,
      testDbResults: [null, 'FAIL', 'PASS'],
    });
  });

  it('counts policy ddl run straight against the database through psql or db query', async () => {
    const commands = [
      `psql "$DATABASE_URL" -c 'drop policy "Enable read access for authenticated users" on public.notes'`,
      `psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -c "create policy p on public.notes for select using (false)"`,
      `supabase db query --local 'alter policy "p" on public.notes using (false)'`,
      `psql "$DATABASE_URL" -c "select * from pg_policies"`,
      `echo 'psql -c "drop policy x on public.notes"'`,
      `cat > supabase/migrations/20260102000000_fix.sql <<'EOF'\ndrop policy x on public.notes;\nEOF`,
      'supabase migration up',
    ];
    const { metrics } = await metricsOf({
      commands,
      invocations: findSupabaseInvocations(commands),
    });
    expect(metrics.directPolicyDdl).toBe(3);
  });

  it('counts pg_prove run by hand, not supabase test db or text that mentions it', async () => {
    const commands = [
      'pg_prove -d postgres supabase/tests/notes_test.sql',
      'pg_prove -r supabase/tests',
      'echo pg_prove',
      'supabase test db',
      'cat supabase/tests/notes_test.sql',
      'psql -f supabase/tests/notes_test.sql',
    ];
    const { metrics } = await metricsOf({
      commands,
      invocations: findSupabaseInvocations(commands),
    });
    expect(metrics.pgProveDirect).toBe(2);
  });

  it('counts the container-runtime detours', async () => {
    const commands = ['sudo dockerd', 'supabase start'];
    const { metrics } = await metricsOf({
      commands,
      invocations: findSupabaseInvocations(commands),
    });
    expect(metrics.cliDetours).toBe(1);
  });

  it('reports the seeded migration as modified and counts the new policy migrations', async () => {
    const { metrics } = await metricsOf({
      migrations: { ok: true, migrations: [SEEDED, FIX], misordered: [] },
    });
    expect(metrics).toMatchObject({
      seededMigrationModified: true,
      newMigrationFiles: 1,
    });
  });

  it('reports no policy migration as an unmodified seed and zero new files', async () => {
    const { metrics } = await metricsOf({
      migrations: { ok: true, migrations: [], misordered: [] },
    });
    expect(metrics).toMatchObject({
      seededMigrationModified: false,
      newMigrationFiles: 0,
    });
  });

  describe('with inputs missing', () => {
    const missing: Partial<Facts> = {
      stack: { ok: false, notes: 'managed: exit 1: no stack running' },
      cli: { versions: null, cliOverride: null },
      migrations: { ok: false, notes: 'supabase/migrations does not exist' },
      suite: { ok: false, notes: 'managed: exit 1: no stack running' },
      testDbRuns: [],
    };

    it('still passes and reports null for every field it could not read', async () => {
      const { check, metrics } = await metricsOf(missing);
      expect(check).toMatchObject({ name: 'metrics', passed: true });
      expect(metrics).toMatchObject({
        cliVersion: null,
        cliOverride: null,
        relocatedHome: null,
        dbPort: null,
        testFiles: null,
        testsPlanned: null,
        testsPassedClean: null,
        catchingFiles: null,
        seededMigrationModified: null,
        newMigrationFiles: null,
        testDbRuns: 0,
        testDbResults: [],
      });
    });

    it('reports no backend or runtime when the stack did not resolve', async () => {
      const { metrics } = await metricsOf(missing);
      expect(metrics).toMatchObject({ backend: 'none', runtime: 'none' });
    });

    it('keeps every other field intact when one input is missing', async () => {
      const { metrics } = await metricsOf({
        suite: { ok: false, notes: 'boom' },
      });
      expect(metrics).toMatchObject({
        testFiles: null,
        backend: 'managed',
        dbPort: 54322,
        testDbRuns: 1,
        newMigrationFiles: 1,
      });
    });

    it('does not throw when nothing was run at all', async () => {
      const { check } = await metricsOf({
        ...missing,
        commands: [],
        invocations: [],
      });
      expect(check.passed).toBe(true);
    });
  });
});
