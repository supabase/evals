// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-001-slow-query
import type {
  CommandResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  findSupabaseInvocations,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import type { StackProbe } from '../lib/stack.js';
import {
  LOOKUP_QUERY,
  SEEDED_MIGRATION_FILE,
  SEEDED_MIGRATION_SHA256,
} from './fixtures.js';
import type { EvidenceCall, InspectRun } from './inspect.js';
import {
  checkMetrics,
  type CliFacts,
  type ProjectFileFacts,
  readCliFacts,
  readProjectFileFacts,
} from './metrics.js';

const DB_URL = 'postgresql://postgres:hunter2@127.0.0.1:54322/postgres';
const CREATE_INDEX_SQL =
  'create index orders_customer_email_idx on public.orders (customer_email)';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.0.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

function result(stdout: string, ok = true, stderr = ''): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr };
}

const versionCtx: Pick<LocalStackEvalContext, 'exec'> = {
  exec: async (command) =>
    command.endsWith('supabase --version')
      ? result('2.0.0\n')
      : result('', false, 'error'),
};

type Project = {
  seededHash?: string | 'missing';
  migrations?: string[];
  throwOn?: Array<'sha256sum' | 'migrations'>;
};

const OTHER_HASH = 'f'.repeat(64);

function fakeProject({
  seededHash = SEEDED_MIGRATION_SHA256,
  migrations = [SEEDED_MIGRATION_FILE],
  throwOn = [],
}: Project = {}): Pick<LocalStackEvalContext, 'exec'> {
  return {
    exec: async (command) => {
      if (command.includes('sha256sum')) {
        if (throwOn.includes('sha256sum')) throw new Error('sandbox gone');
        if (!command.includes(SEEDED_MIGRATION_FILE)) {
          return result('', false, `unexpected command: ${command}`);
        }
        return seededHash === 'missing'
          ? result(
              '',
              false,
              `sha256sum: supabase/migrations/${SEEDED_MIGRATION_FILE}: No such file or directory`
            )
          : result(
              `${seededHash}  supabase/migrations/${SEEDED_MIGRATION_FILE}\n`
            );
      }
      if (command.includes('supabase/migrations')) {
        if (throwOn.includes('migrations')) throw new Error('sandbox gone');
        return command.includes('find ')
          ? result(
              migrations.map((name) => `supabase/migrations/${name}`).join('\n')
            )
          : result(migrations.join('\n'));
      }
      return result('', false, `unexpected command: ${command}`);
    },
  };
}

describe('readProjectFileFacts', () => {
  it('reports an untouched project', async () => {
    expect(await readProjectFileFacts(fakeProject())).toEqual({
      seededMigrationModified: false,
      newMigrationFiles: 0,
    });
  });

  it('counts migration files beside the seeded one', async () => {
    const ctx = fakeProject({
      migrations: [
        SEEDED_MIGRATION_FILE,
        '20260102000000_add_orders_customer_email_idx.sql',
        '20260103000000_more.sql',
      ],
    });
    expect(await readProjectFileFacts(ctx)).toEqual({
      seededMigrationModified: false,
      newMigrationFiles: 2,
    });
  });

  it('does not count files that are not .sql', async () => {
    const ctx = fakeProject({
      migrations: [SEEDED_MIGRATION_FILE, 'README.md', '.gitkeep'],
    });
    expect((await readProjectFileFacts(ctx)).newMigrationFiles).toBe(0);
  });

  it('reports a seeded migration whose checksum changed', async () => {
    const ctx = fakeProject({ seededHash: OTHER_HASH });
    expect(await readProjectFileFacts(ctx)).toEqual({
      seededMigrationModified: true,
      newMigrationFiles: 0,
    });
  });

  it('reports a deleted seeded migration as modified and still counts the others', async () => {
    const ctx = fakeProject({
      seededHash: 'missing',
      migrations: ['20260102000000_add_orders_customer_email_idx.sql'],
    });
    expect(await readProjectFileFacts(ctx)).toEqual({
      seededMigrationModified: true,
      newMigrationFiles: 1,
    });
  });

  it.each([
    [
      'the checksum probe',
      'sha256sum',
      { seededMigrationModified: null, newMigrationFiles: 1 },
    ],
    [
      'the migrations listing',
      'migrations',
      { seededMigrationModified: false, newMigrationFiles: null },
    ],
  ] satisfies Array<[string, 'sha256sum' | 'migrations', ProjectFileFacts]>)(
    'loses only its own field when %s throws',
    async (_label, throwOn, expected) => {
      const ctx = fakeProject({
        migrations: [
          SEEDED_MIGRATION_FILE,
          '20260102000000_add_orders_customer_email_idx.sql',
        ],
        throwOn: [throwOn],
      });
      expect(await readProjectFileFacts(ctx)).toEqual(expected);
    }
  );

  it('reports every field as unknown when every probe throws', async () => {
    const ctx = fakeProject({ throwOn: ['sha256sum', 'migrations'] });
    expect(await readProjectFileFacts(ctx)).toEqual({
      seededMigrationModified: null,
      newMigrationFiles: null,
    });
  });
});

describe('readCliFacts', () => {
  it('reports the staged version with no override for a plain run', async () => {
    const invocations = findSupabaseInvocations(['supabase start']);
    expect(await readCliFacts(versionCtx, MARKER, invocations)).toEqual({
      versions: { cliVersion: '2.0.0' },
      cliOverride: [],
    });
  });

  it('reports a version-swapping runner and a PATH version that moved', async () => {
    const moved: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => result('2.2.0\n'),
    };
    const invocations = findSupabaseInvocations([
      'npx --yes supabase@2.1.0 inspect db outliers --local',
    ]);
    expect(await readCliFacts(moved, MARKER, invocations)).toEqual({
      versions: { cliVersion: '2.0.0', cliVersionAfterRun: '2.2.0' },
      cliOverride: ['npx --yes supabase@2.1.0'],
    });
  });

  it('reports an unknown version without failing when the sandbox is unreachable', async () => {
    const gone: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => {
        throw new Error('sandbox gone');
      },
    };
    expect(await readCliFacts(gone, undefined, [])).toMatchObject({
      versions: { cliVersion: null },
    });
  });
});

const STACK: StackProbe = {
  ok: true,
  backend: 'managed',
  dbUrl: DB_URL,
  runtime: 'native',
};

const NO_STACK: StackProbe = { ok: false, notes: 'none' };
const NO_CLI: CliFacts = { versions: null, cliOverride: null };
const FILES: ProjectFileFacts = {
  seededMigrationModified: false,
  newMigrationFiles: 1,
};

type MetricsFacts = Parameters<typeof checkMetrics>[1];

const run = (overrides: Partial<InspectRun> = {}): InspectRun => ({
  commandIndex: 0,
  report: 'db outliers',
  errored: false,
  ...overrides,
});

const evidenceCall = (overrides: Partial<EvidenceCall> = {}): EvidenceCall => ({
  commandIndex: 0,
  kind: 'candidate',
  command: 'supabase inspect db outliers --local',
  output: 'public.orders',
  namesOrders: true,
  ...overrides,
});

function metricsFacts(overrides: Partial<MetricsFacts> = {}): MetricsFacts {
  const commands = overrides.commands ?? [];
  return {
    commands,
    invocations: overrides.invocations ?? findSupabaseInvocations(commands),
    stack: STACK,
    cli: { versions: { cliVersion: '2.0.0' }, cliOverride: [] },
    files: FILES,
    inspectRuns: [],
    inspectEvidence: [],
    indexes: {
      ok: true,
      indexes: [
        { name: 'orders_pkey', definition: 'CREATE UNIQUE INDEX orders_pkey' },
      ],
    },
    rows: { ok: true, count: 300_000 },
    ...overrides,
  };
}

const metricsOf = (check: { notes?: string }) =>
  JSON.parse(check.notes ?? '{}');

const metricsFor = async (overrides: Partial<MetricsFacts> = {}) =>
  metricsOf(await checkMetrics(MARKER, metricsFacts(overrides)));

const unreadable = <T>() =>
  new Proxy([], {
    get() {
      throw new Error('unreadable');
    },
  }) as unknown as T;

const workflow = async (commands: string[]) =>
  (await metricsFor({ commands })).workflowCommands;

describe('checkMetrics', () => {
  it('reports every field of a finished run and always passes', async () => {
    const commands = [
      'supabase start',
      'supabase inspect db outliers --local',
      `psql '${DB_URL}' -XtAc "explain (format json) ${LOOKUP_QUERY}"`,
      `psql '${DB_URL}' -XtAc "${CREATE_INDEX_SQL}"`,
      'supabase migration up',
      'sudo apt-get install docker.io',
    ];
    const check = await checkMetrics(
      MARKER,
      metricsFacts({
        commands,
        inspectRuns: [run({ commandIndex: 1 })],
        inspectEvidence: [evidenceCall({ commandIndex: 1 })],
        indexes: {
          ok: true,
          indexes: [
            {
              name: 'orders_pkey',
              definition: 'CREATE UNIQUE INDEX orders_pkey',
            },
            {
              name: 'orders_customer_email_idx',
              definition: CREATE_INDEX_SQL,
            },
          ],
        },
      })
    );
    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toEqual({
      cliVersion: '2.0.0',
      cliOverride: [],
      channel: 'beta',
      backend: 'managed',
      runtime: 'native',
      relocatedHome: null,
      dbPort: 54322,
      inspectReports: ['db outliers'],
      inspectRuns: 1,
      inspectCallsNamingOrders: 1,
      workflowCommands: ['start', 'inspect db outliers', 'migration up'],
      explainCommands: 1,
      directIndexDdl: 1,
      ordersIndexes: ['orders_pkey', 'orders_customer_email_idx'],
      orderRows: 300_000,
      newMigrationFiles: 1,
      seededMigrationModified: false,
      cliDetours: 1,
    });
  });

  it('reports the relocated home and the version the PATH moved to', async () => {
    const metrics = await metricsFor({
      stack: { ...STACK, relocatedHome: '/tmp/agent/.supabase' },
      cli: {
        versions: { cliVersion: '2.0.0', cliVersionAfterRun: '2.2.0' },
        cliOverride: ['npx --yes supabase@2.1.0'],
      },
    });
    expect(metrics).toMatchObject({
      relocatedHome: '/tmp/agent/.supabase',
      cliVersion: '2.0.0',
      cliVersionAfterRun: '2.2.0',
      cliOverride: ['npx --yes supabase@2.1.0'],
    });
  });

  it('leaves out cliVersionAfterRun when the PATH version did not move', async () => {
    expect(await metricsFor()).not.toHaveProperty('cliVersionAfterRun');
  });

  it('reports the pinned channel when the marker names none or is absent', async () => {
    const unchanneled = { ...MARKER, channel: undefined };
    expect(
      metricsOf(await checkMetrics(unchanneled, metricsFacts())).channel
    ).toBe('pinned');
    expect(
      metricsOf(await checkMetrics(undefined, metricsFacts())).channel
    ).toBe('pinned');
  });

  it('reports a stopped stack as none with no port', async () => {
    expect(await metricsFor({ stack: NO_STACK })).toMatchObject({
      backend: 'none',
      runtime: 'none',
      relocatedHome: null,
      dbPort: null,
    });
  });

  it('never carries the stack credentials', async () => {
    const check = await checkMetrics(MARKER, metricsFacts());
    expect(check.notes).not.toContain('hunter2');
  });

  it('passes with nulls and zeros instead of failing when nothing could be read', async () => {
    const check = await checkMetrics(undefined, {
      commands: [],
      invocations: [],
      stack: NO_STACK,
      cli: NO_CLI,
      files: { seededMigrationModified: null, newMigrationFiles: null },
      inspectRuns: [],
      inspectEvidence: [],
      indexes: { ok: false, notes: 'none' },
      rows: { ok: false, notes: 'none' },
    });
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toEqual({
      cliVersion: null,
      cliOverride: null,
      channel: 'pinned',
      backend: 'none',
      runtime: 'none',
      relocatedHome: null,
      dbPort: null,
      inspectReports: [],
      inspectRuns: 0,
      inspectCallsNamingOrders: 0,
      workflowCommands: [],
      explainCommands: 0,
      directIndexDdl: 0,
      ordersIndexes: null,
      orderRows: null,
      newMigrationFiles: null,
      seededMigrationModified: null,
      cliDetours: 0,
    });
  });

  describe('workflowCommands', () => {
    it.each([
      ['supabase start', 'start'],
      ['supabase start -x gotrue,imgproxy', 'start'],
      ['supabase stop', 'stop'],
      ['supabase status', 'status'],
      ['supabase link', 'link'],
      ['supabase stack start', 'stack start'],
      ['supabase stack list', 'stack list'],
      ['supabase migration up', 'migration up'],
      ['supabase migration up --local', 'migration up'],
      ['supabase migration new add_orders_customer_email_idx', 'migration new'],
      [
        'supabase migration repair --status applied 20260102000000 --local',
        'migration repair',
      ],
      ['supabase db reset', 'db reset'],
      ['supabase db push --local', 'db push'],
      ['supabase db diff -f add_idx', 'db diff'],
      ['supabase db query --local "select 1"', 'db query'],
      ['supabase inspect db outliers --local', 'inspect db outliers'],
      [
        'supabase inspect db table-stats --local -o json',
        'inspect db table-stats',
      ],
      [
        'supabase inspect db calls --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres',
        'inspect db calls',
      ],
      ['supabase inspect db seq-scans --local', 'inspect db seq-scans'],
      ['supabase inspect db', 'inspect db'],
      [
        'supabase --workdir /ws inspect db outliers --local',
        'inspect db outliers',
      ],
      ['supabase --workdir /ws db reset', 'db reset'],
      ['supabase --runtime native start', 'start'],
      ['supabase --stack dev start', 'start'],
      ['npx --yes supabase@2.120.0 migration up', 'migration up'],
      [
        'npx supabase@beta inspect db calls --local | head -40',
        'inspect db calls',
      ],
    ])('records %j as %j', async (command, expected) => {
      expect(await workflow([command])).toEqual([expected]);
    });

    it('lists each distinct command once, in first-use order', async () => {
      expect(
        await workflow([
          'supabase start',
          'supabase inspect db outliers --local',
          'supabase start',
          'supabase inspect db table-stats --local',
          'supabase migration up',
          'supabase inspect db outliers',
          'supabase db reset',
          'supabase migration up --local',
        ])
      ).toEqual([
        'start',
        'inspect db outliers',
        'inspect db table-stats',
        'migration up',
        'db reset',
      ]);
    });

    it('skips invocations that name no subcommand and commands that are not supabase', async () => {
      expect(
        await workflow([
          'supabase',
          'supabase --version',
          `psql '${DB_URL}' -c "select 1"`,
          'npm run dev',
        ])
      ).toEqual([]);
    });
  });

  describe('inspect fields', () => {
    const commands = [
      'supabase inspect db outliers',
      'supabase inspect db outliers --local',
      'supabase inspect db calls --local',
    ];

    it('counts the runs, the evidence calls naming orders and the distinct reports in first-use order', async () => {
      expect(
        await metricsFor({
          commands,
          inspectRuns: [
            run({ commandIndex: 0, errored: true }),
            run({ commandIndex: 1 }),
            run({ commandIndex: 2, report: 'db calls' }),
          ],
          inspectEvidence: [
            evidenceCall({ commandIndex: 0, namesOrders: false }),
            evidenceCall({ commandIndex: 1 }),
            evidenceCall({
              commandIndex: 2,
              kind: 'later call naming an output path',
            }),
          ],
        })
      ).toMatchObject({
        inspectReports: ['db outliers', 'db calls'],
        inspectRuns: 3,
        inspectCallsNamingOrders: 2,
      });
    });

    it('reports no reports for a run that never used inspect', async () => {
      expect(await metricsFor({ commands: ['supabase start'] })).toMatchObject({
        inspectReports: [],
        inspectRuns: 0,
        inspectCallsNamingOrders: 0,
      });
    });

    it('counts a call that named orders although it errored', async () => {
      expect(
        await metricsFor({
          commands: ['supabase inspect db outliers --local | head -40'],
          inspectRuns: [run({ errored: true })],
          inspectEvidence: [evidenceCall()],
        })
      ).toMatchObject({ inspectRuns: 1, inspectCallsNamingOrders: 1 });
    });
  });

  describe('explainCommands', () => {
    it.each([
      [
        'psql with -c',
        'psql "$DATABASE_URL" -c "explain select * from public.orders"',
      ],
      [
        'psql with the connection string inline and the plan as JSON',
        `psql '${DB_URL}' -XtAc "explain (format json) ${LOOKUP_QUERY}"`,
      ],
      [
        'psql behind an environment prefix and an uppercase statement',
        `PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -c "EXPLAIN (ANALYZE, BUFFERS) select * from public.orders where customer_email = 'a'"`,
      ],
      [
        'supabase db query',
        'supabase db query "explain select * from public.orders"',
      ],
      [
        'supabase db query with a flag',
        'supabase db query --local "explain analyze select * from public.orders"',
      ],
      [
        'db query through a package runner',
        'npx supabase db query "explain select 1"',
      ],
      [
        'a statement after another command',
        'cd /ws && psql "$DATABASE_URL" -c "explain select 1"',
      ],
    ])('counts %s', async (_label, command) => {
      expect((await metricsFor({ commands: [command] })).explainCommands).toBe(
        1
      );
    });

    it.each([
      ['an echo that names it', 'echo "I will run explain on the lookup"'],
      ['a grep for it', 'grep -i explain notes.md'],
      ['a file named after it', 'cat explain.sql'],
      ['a psql select', 'psql "$DATABASE_URL" -c "select 1"'],
      [
        'a psql select of an explain_col column',
        'psql "$DATABASE_URL" -c "select explain_col from public.orders"',
      ],
      [
        'a psql select of a word that contains it',
        `psql "$DATABASE_URL" -c "select 'unexplained', 'explaining'"`,
      ],
      ['supabase db query reading rows', 'supabase db query "select 1"'],
      ['an inspect report', 'supabase inspect db outliers --local'],
      ['a migration named after it', 'supabase migration new explain_plans'],
      [
        'explain named in a sibling segment of a psql call',
        'psql "$DATABASE_URL" -c "select 1" && echo "explain later"',
      ],
    ])('does not count %s', async (_label, command) => {
      expect((await metricsFor({ commands: [command] })).explainCommands).toBe(
        0
      );
    });

    it('counts each qualifying command once', async () => {
      const metrics = await metricsFor({
        commands: [
          'psql "$DATABASE_URL" -c "explain select 1" && psql "$DATABASE_URL" -c "explain select 2"',
          'supabase migration up',
          'supabase db query "explain select 3"',
        ],
      });
      expect(metrics.explainCommands).toBe(2);
    });
  });

  describe('directIndexDdl', () => {
    it.each([
      [
        'psql with -c',
        'psql "$DATABASE_URL" -c "create index on public.orders (customer_email)"',
      ],
      [
        'psql with the connection string inline and an uppercase statement',
        `psql '${DB_URL}' -XtAc "CREATE UNIQUE INDEX CONCURRENTLY orders_idx ON public.orders (customer_email)"`,
      ],
      [
        'psql by absolute path behind an environment prefix',
        `PGPASSWORD=postgres /usr/bin/psql -h 127.0.0.1 -U postgres -c "${CREATE_INDEX_SQL}"`,
      ],
      ['supabase db query', `supabase db query "${CREATE_INDEX_SQL}"`],
      [
        'supabase db query with a flag',
        `supabase db query --local "${CREATE_INDEX_SQL}"`,
      ],
      [
        'db query through a package runner',
        `npx supabase db query "${CREATE_INDEX_SQL}"`,
      ],
      [
        'a statement after another command',
        `cd /ws && psql "$DATABASE_URL" -c "${CREATE_INDEX_SQL}"`,
      ],
    ])('counts %s', async (_label, command) => {
      expect((await metricsFor({ commands: [command] })).directIndexDdl).toBe(
        1
      );
    });

    it.each([
      [
        'a heredoc writing a migration file',
        `cat > supabase/migrations/20260102000000_idx.sql <<'EOF'\n${CREATE_INDEX_SQL};\nEOF`,
      ],
      [
        'echo into a migration file',
        `echo "${CREATE_INDEX_SQL};" > supabase/migrations/20260102000000_idx.sql`,
      ],
      [
        'a psql select',
        'psql "$DATABASE_URL" -c "select count(*) from public.orders"',
      ],
      [
        'a psql drop of an index',
        'psql "$DATABASE_URL" -c "drop index orders_customer_email_idx"',
      ],
      [
        'a psql create table',
        'psql "$DATABASE_URL" -c "create table public.audit (id int)"',
      ],
      [
        'a psql explain',
        'psql "$DATABASE_URL" -c "explain select * from public.orders"',
      ],
      ['applying migrations', 'supabase migration up'],
      [
        'an echo that names the statement',
        `echo "I will run: ${CREATE_INDEX_SQL}"`,
      ],
      [
        'the statement named in a sibling segment of a psql call',
        `psql "$DATABASE_URL" -c "select 1" && echo "${CREATE_INDEX_SQL}"`,
      ],
    ])('does not count %s', async (_label, command) => {
      expect((await metricsFor({ commands: [command] })).directIndexDdl).toBe(
        0
      );
    });

    it('counts each qualifying command once', async () => {
      const metrics = await metricsFor({
        commands: [
          `psql "$DATABASE_URL" -c "${CREATE_INDEX_SQL}" && psql "$DATABASE_URL" -c "create index on public.orders (status)"`,
          'supabase migration up',
          `supabase db query "${CREATE_INDEX_SQL}"`,
        ],
      });
      expect(metrics.directIndexDdl).toBe(2);
    });
  });

  describe('ordersIndexes and orderRows', () => {
    it('lists the index names on orders', async () => {
      const metrics = await metricsFor({
        indexes: {
          ok: true,
          indexes: [
            {
              name: 'orders_pkey',
              definition: 'CREATE UNIQUE INDEX orders_pkey',
            },
            { name: 'orders_customer_email_idx', definition: CREATE_INDEX_SQL },
          ],
        },
      });
      expect(metrics.ordersIndexes).toEqual([
        'orders_pkey',
        'orders_customer_email_idx',
      ]);
    });

    it('reports a table with no indexes as an empty list, not null', async () => {
      expect(
        (await metricsFor({ indexes: { ok: true, indexes: [] } })).ordersIndexes
      ).toEqual([]);
    });

    it('reports an empty orders table as 0 rows rather than unknown', async () => {
      expect(
        (await metricsFor({ rows: { ok: true, count: 0 } })).orderRows
      ).toBe(0);
    });

    it('reports unreadable probes as null', async () => {
      expect(
        await metricsFor({
          indexes: { ok: false, notes: 'exit 1' },
          rows: { ok: false, notes: 'exit 1' },
        })
      ).toMatchObject({ ordersIndexes: null, orderRows: null });
    });
  });

  it('counts the commands that look like container-runtime detours', async () => {
    const metrics = await metricsFor({
      commands: [
        'supabase start',
        'sudo apt-get install docker.io',
        'supabase inspect db outliers --local',
      ],
    });
    expect(metrics.cliDetours).toBe(1);
  });

  it('passes on the migration file facts it was given', async () => {
    expect(
      await metricsFor({
        files: { seededMigrationModified: true, newMigrationFiles: 0 },
      })
    ).toMatchObject({ seededMigrationModified: true, newMigrationFiles: 0 });
  });

  describe('when one input cannot be read', () => {
    const commands = [
      'supabase start',
      'supabase inspect db outliers --local',
      `psql "$DATABASE_URL" -c "explain select 1"`,
      `psql "$DATABASE_URL" -c "${CREATE_INDEX_SQL}"`,
      'sudo apt-get install docker.io',
    ];

    it('keeps the other fields when the invocations cannot be read', async () => {
      const metrics = await metricsFor({
        commands,
        invocations: unreadable<readonly SupabaseInvocation[]>(),
        inspectRuns: [run({ commandIndex: 1 })],
        inspectEvidence: [evidenceCall({ commandIndex: 1 })],
      });
      expect(metrics).toMatchObject({
        workflowCommands: null,
        explainCommands: 1,
        directIndexDdl: 1,
        cliDetours: 1,
        inspectRuns: 1,
        inspectCallsNamingOrders: 1,
        orderRows: 300_000,
        newMigrationFiles: 1,
        seededMigrationModified: false,
      });
    });

    it('keeps the invocation-based fields when the commands cannot be read', async () => {
      const metrics = await metricsFor({
        commands: unreadable<readonly string[]>(),
        invocations: findSupabaseInvocations(commands),
        inspectRuns: [run({ commandIndex: 1 })],
      });
      expect(metrics).toMatchObject({
        workflowCommands: ['start', 'inspect db outliers'],
        explainCommands: null,
        directIndexDdl: null,
        cliDetours: null,
        inspectRuns: 1,
        orderRows: 300_000,
      });
    });

    it('keeps the other fields when the inspect runs cannot be read', async () => {
      const metrics = await metricsFor({
        commands,
        inspectRuns: unreadable<readonly InspectRun[]>(),
      });
      expect(metrics).toMatchObject({
        inspectRuns: null,
        inspectReports: null,
        workflowCommands: ['start', 'inspect db outliers'],
        explainCommands: 1,
        directIndexDdl: 1,
        cliDetours: 1,
        orderRows: 300_000,
      });
    });

    it('keeps the other fields when the inspect evidence cannot be read', async () => {
      const metrics = await metricsFor({
        commands,
        inspectRuns: [run({ commandIndex: 1 })],
        inspectEvidence: unreadable<readonly EvidenceCall[]>(),
      });
      expect(metrics).toMatchObject({
        inspectCallsNamingOrders: null,
        inspectRuns: 1,
        inspectReports: ['db outliers'],
        orderRows: 300_000,
      });
    });

    it('loses only ordersIndexes when the index probe cannot be read', async () => {
      const metrics = await metricsFor({
        commands,
        indexes: unreadable<MetricsFacts['indexes']>(),
      });
      expect(metrics).toMatchObject({
        ordersIndexes: null,
        orderRows: 300_000,
        explainCommands: 1,
        workflowCommands: ['start', 'inspect db outliers'],
      });
    });

    it('loses only orderRows when the count probe cannot be read', async () => {
      const metrics = await metricsFor({
        commands,
        rows: unreadable<MetricsFacts['rows']>(),
      });
      expect(metrics).toMatchObject({
        orderRows: null,
        ordersIndexes: ['orders_pkey'],
        explainCommands: 1,
      });
    });

    it('still passes', async () => {
      const check = await checkMetrics(
        MARKER,
        metricsFacts({
          commands: unreadable<readonly string[]>(),
          invocations: unreadable<readonly SupabaseInvocation[]>(),
          inspectRuns: unreadable<readonly InspectRun[]>(),
          inspectEvidence: unreadable<readonly EvidenceCall[]>(),
          indexes: unreadable<MetricsFacts['indexes']>(),
          rows: unreadable<MetricsFacts['rows']>(),
        })
      );
      expect(check).toMatchObject({ name: 'metrics', passed: true });
    });
  });
});
