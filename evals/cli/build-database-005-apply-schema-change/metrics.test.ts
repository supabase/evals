// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/build-database-005-apply-schema-change
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
import { SEEDED_MIGRATION_FILE, SEEDED_MIGRATION_SHA256 } from './fixtures.js';
import {
  checkMetrics,
  countDirectDdl,
  listWorkflowCommands,
  readCliFacts,
  readProjectFileFacts,
  type CliFacts,
  type ProjectFileFacts,
} from './metrics.js';

const DB_URL = 'postgresql://postgres:hunter2@127.0.0.1:54322/postgres';
const ADD_DUE_DATE_SQL = 'alter table public.tasks add column due_date date';

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

const workflow = (commands: string[]) =>
  listWorkflowCommands(findSupabaseInvocations(commands));

describe('listWorkflowCommands', () => {
  it.each([
    ['supabase start', 'start'],
    ['supabase stack start', 'stack start'],
    ['supabase migration up', 'migration up'],
    ['supabase migration up --local', 'migration up'],
    ['supabase db reset', 'db reset'],
    ['supabase --workdir /ws db reset', 'db reset'],
    ['supabase migration new add_due_date', 'migration new'],
    ['supabase db diff -f add_due_date', 'db diff'],
    ['supabase db push --local', 'db push'],
    [
      'supabase migration repair --status applied 20260102000000 --local',
      'migration repair',
    ],
    ['supabase start -x gotrue,imgproxy', 'start'],
    [
      'supabase db schema declarative sync --apply',
      'db schema declarative sync',
    ],
    ['npx --yes supabase@2.120.0 migration up', 'migration up'],
    ['supabase --runtime native start', 'start'],
    ['supabase --stack dev start', 'start'],
    ['supabase --stack-id dev start', 'start'],
    ['supabase --project-id tasks-app start', 'start'],
    ['supabase -x studio start', 'start'],
    ['supabase --exclude studio start', 'start'],
    ['supabase --runtime=native --stack dev db reset', 'db reset'],
  ])('records %j as %j', (command, expected) => {
    expect(workflow([command])).toEqual([expected]);
  });

  it('keeps at most four words of the subcommand', () => {
    expect(
      workflow(['supabase db schema declarative sync extra --apply'])
    ).toEqual(['db schema declarative sync']);
  });

  it('lists each distinct command once, in first-use order', () => {
    expect(
      workflow([
        'supabase start',
        'supabase migration up',
        'supabase start',
        'supabase db reset',
        'supabase migration up --local',
      ])
    ).toEqual(['start', 'migration up', 'db reset']);
  });

  it('skips invocations that name no subcommand and commands that are not supabase', () => {
    expect(
      workflow([
        'supabase',
        'supabase --version',
        'psql postgresql://127.0.0.1:54322/postgres -c "select 1"',
        'npm run dev',
      ])
    ).toEqual([]);
  });

  it('is empty when the agent ran nothing', () => {
    expect(listWorkflowCommands([])).toEqual([]);
  });
});

describe('countDirectDdl', () => {
  it.each([
    ['psql with -c', `psql "$DATABASE_URL" -c "${ADD_DUE_DATE_SQL}"`],
    [
      'psql with the connection string inline',
      `psql '${DB_URL}' -tAc "${ADD_DUE_DATE_SQL};"`,
    ],
    [
      'psql behind an environment prefix',
      `PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -c "${ADD_DUE_DATE_SQL}"`,
    ],
    [
      'psql by absolute path',
      `/usr/bin/psql "$DATABASE_URL" -c "${ADD_DUE_DATE_SQL}"`,
    ],
    [
      'uppercase statement',
      'psql "$DATABASE_URL" -c "ALTER TABLE public.tasks ADD COLUMN DUE_DATE date"',
    ],
    ['supabase db query', `supabase db query "${ADD_DUE_DATE_SQL}"`],
    [
      'supabase db query with a flag',
      `supabase db query --local "${ADD_DUE_DATE_SQL}"`,
    ],
    [
      'db query through a package runner',
      `npx supabase db query "${ADD_DUE_DATE_SQL}"`,
    ],
    [
      'a statement after another command',
      `cd /ws && psql "$DATABASE_URL" -c "${ADD_DUE_DATE_SQL}"`,
    ],
    [
      'a heredoc fed to psql',
      `psql "$DATABASE_URL" <<'SQL'\n${ADD_DUE_DATE_SQL};\nSQL`,
    ],
    [
      'a heredoc fed to supabase db query',
      `supabase db query <<'SQL'\n${ADD_DUE_DATE_SQL};\nSQL`,
    ],
    [
      'an echo piped into psql',
      `echo "${ADD_DUE_DATE_SQL};" | psql "$DATABASE_URL"`,
    ],
    [
      'a printf piped into psql in a subshell',
      `(printf '%s;' "${ADD_DUE_DATE_SQL}" | psql "$DATABASE_URL")`,
    ],
    [
      'a heredoc that writes a file psql -f then runs',
      `cat > add_due_date.sql <<'EOF'\n${ADD_DUE_DATE_SQL};\nEOF\npsql "$DATABASE_URL" -f add_due_date.sql`,
    ],
    [
      'psql applying a migration file by hand',
      'psql "$DATABASE_URL" -f supabase/migrations/20260102000000_add_due_date.sql',
    ],
    [
      'psql applying a migration file by an absolute path with --file',
      'psql "$DATABASE_URL" --file=/ws/supabase/migrations/20260102000000_add_due_date.sql',
    ],
    [
      'psql applying a quoted migration file path',
      `psql "$DATABASE_URL" -f "./supabase/migrations/20260102000000_add_due_date.sql"`,
    ],
  ])('counts %s', (_label, command) => {
    expect(countDirectDdl([command])).toBe(1);
  });

  it.each([
    [
      'a heredoc writing a migration file',
      `cat > supabase/migrations/20260102000000_add_due_date.sql <<'EOF'\n${ADD_DUE_DATE_SQL};\nEOF`,
    ],
    [
      'echo into a migration file',
      `echo "${ADD_DUE_DATE_SQL};" > supabase/migrations/20260102000000_add_due_date.sql`,
    ],
    [
      'psql running a file outside the migrations folder that holds no DDL',
      'psql "$DATABASE_URL" -f scripts/seed.sql',
    ],
    [
      'a heredoc writing a file with no psql or db query in the command',
      `cat > add_due_date.sql <<'EOF'\n${ADD_DUE_DATE_SQL};\nEOF`,
    ],
    [
      'an echo mentioning a migration path and psql -f in prose',
      'echo "run psql -f supabase/migrations/x.sql later"',
    ],
    [
      'a psql read of due_date',
      'psql "$DATABASE_URL" -c "select due_date from public.tasks"',
    ],
    [
      'a psql alter of another column',
      `psql "$DATABASE_URL" -c "alter table public.tasks add column priority int"`,
    ],
    [
      'a psql select',
      'psql "$DATABASE_URL" -c "select count(*) from public.tasks"',
    ],
    [
      'supabase db query reading rows',
      'supabase db query "select * from public.tasks"',
    ],
    ['creating a migration', 'supabase migration new add_due_date'],
    ['applying migrations', 'supabase migration up'],
    [
      'an echo mentioning the statement',
      `echo "I will run: ${ADD_DUE_DATE_SQL}"`,
    ],
  ])('does not count %s', (_label, command) => {
    expect(countDirectDdl([command])).toBe(0);
  });

  it('counts a command once however many statements it runs', () => {
    expect(
      countDirectDdl([
        `psql "$DATABASE_URL" -c "${ADD_DUE_DATE_SQL}" && psql "$DATABASE_URL" -c "alter table public.tasks alter column due_date set default null"`,
      ])
    ).toBe(1);
  });

  it('counts each qualifying command', () => {
    expect(
      countDirectDdl([
        `psql "$DATABASE_URL" -c "${ADD_DUE_DATE_SQL}"`,
        'supabase migration up',
        `supabase db query "${ADD_DUE_DATE_SQL}"`,
      ])
    ).toBe(2);
  });

  it('is zero when the agent ran nothing', () => {
    expect(countDirectDdl([])).toBe(0);
  });
});

type Project = {
  seededHash?: string | 'missing';
  migrations?: string[];
  schemas?: string[] | 'absent';
  throwOn?: Array<'sha256sum' | 'migrations' | 'schemas'>;
};

const OTHER_HASH = 'f'.repeat(64);

// A probe is answered by what it asks about, so any command shape that lists the directory or checksums the file gets the same state.
function fakeProject({
  seededHash = SEEDED_MIGRATION_SHA256,
  migrations = [SEEDED_MIGRATION_FILE],
  schemas = 'absent',
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
      if (command.includes('supabase/schemas')) {
        if (throwOn.includes('schemas')) throw new Error('sandbox gone');
        return schemas === 'absent'
          ? result(
              '',
              false,
              "find: 'supabase/schemas': No such file or directory"
            )
          : result(
              schemas.map((path) => `supabase/schemas/${path}`).join('\n')
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
      declarativeSchemaFiles: 0,
    });
  });

  it('counts migration files beside the seeded one', async () => {
    const ctx = fakeProject({
      migrations: [
        SEEDED_MIGRATION_FILE,
        '20260102000000_add_due_date.sql',
        '20260103000000_more.sql',
      ],
    });
    expect(await readProjectFileFacts(ctx)).toMatchObject({
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
    expect(await readProjectFileFacts(ctx)).toMatchObject({
      seededMigrationModified: true,
      newMigrationFiles: 0,
    });
  });

  it('reports a deleted seeded migration as modified and still counts the others', async () => {
    const ctx = fakeProject({
      seededHash: 'missing',
      migrations: ['20260102000000_add_due_date.sql'],
    });
    expect(await readProjectFileFacts(ctx)).toMatchObject({
      seededMigrationModified: true,
      newMigrationFiles: 1,
    });
  });

  it('counts .sql files under supabase/schemas recursively', async () => {
    const ctx = fakeProject({
      schemas: ['tasks.sql', 'nested/deeper/extra.sql', 'README.md'],
    });
    expect((await readProjectFileFacts(ctx)).declarativeSchemaFiles).toBe(2);
  });

  it('reports zero schema files when supabase/schemas is empty', async () => {
    const ctx = fakeProject({ schemas: [] });
    expect((await readProjectFileFacts(ctx)).declarativeSchemaFiles).toBe(0);
  });

  it('reports zero schema files when supabase/schemas does not exist', async () => {
    const ctx = fakeProject({ schemas: 'absent' });
    expect((await readProjectFileFacts(ctx)).declarativeSchemaFiles).toBe(0);
  });

  it.each([
    [
      'the checksum probe',
      'sha256sum',
      {
        seededMigrationModified: null,
        newMigrationFiles: 1,
        declarativeSchemaFiles: 1,
      },
    ],
    [
      'the migrations listing',
      'migrations',
      {
        seededMigrationModified: false,
        newMigrationFiles: null,
        declarativeSchemaFiles: 1,
      },
    ],
    [
      'the schemas listing',
      'schemas',
      {
        seededMigrationModified: false,
        newMigrationFiles: 1,
        declarativeSchemaFiles: null,
      },
    ],
  ] satisfies Array<
    [string, 'sha256sum' | 'migrations' | 'schemas', ProjectFileFacts]
  >)(
    'loses only its own field when %s throws',
    async (_label, throwOn, expected) => {
      const ctx = fakeProject({
        migrations: [SEEDED_MIGRATION_FILE, '20260102000000_add_due_date.sql'],
        schemas: ['tasks.sql'],
        throwOn: [throwOn],
      });
      expect(await readProjectFileFacts(ctx)).toEqual(expected);
    }
  );

  it('reports every field as unknown when every probe throws', async () => {
    const ctx = fakeProject({
      throwOn: ['sha256sum', 'migrations', 'schemas'],
    });
    expect(await readProjectFileFacts(ctx)).toEqual({
      seededMigrationModified: null,
      newMigrationFiles: null,
      declarativeSchemaFiles: null,
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
      'npx --yes supabase@2.1.0 start',
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
  declarativeSchemaFiles: 0,
};

type MetricsFacts = Parameters<typeof checkMetrics>[1];

function metricsFacts(overrides: Partial<MetricsFacts> = {}): MetricsFacts {
  const commands = overrides.commands ?? [];
  return {
    commands,
    invocations: overrides.invocations ?? findSupabaseInvocations(commands),
    stack: STACK,
    cli: { versions: { cliVersion: '2.0.0' }, cliOverride: [] },
    files: FILES,
    taskRows: 3,
    ...overrides,
  };
}

const metricsOf = (check: { notes?: string }) =>
  JSON.parse(check.notes ?? '{}');

const unreadable = <T>() =>
  new Proxy([], {
    get() {
      throw new Error('unreadable');
    },
  }) as unknown as T;

describe('checkMetrics', () => {
  it('reports every field and always passes', async () => {
    const check = await checkMetrics(
      MARKER,
      metricsFacts({
        commands: [
          'supabase start',
          `psql "$DATABASE_URL" -c "${ADD_DUE_DATE_SQL}"`,
          'supabase migration up',
          'sudo apt-get install docker.io',
        ],
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
      workflowCommands: ['start', 'migration up'],
      directDdlCommands: 1,
      cliDetours: 1,
      seededMigrationModified: false,
      newMigrationFiles: 1,
      declarativeSchemaFiles: 0,
      taskRows: 3,
    });
  });

  it('reports the relocated home and the version the PATH moved to', async () => {
    const check = await checkMetrics(
      MARKER,
      metricsFacts({
        stack: { ...STACK, relocatedHome: '/tmp/agent/.supabase' },
        cli: {
          versions: { cliVersion: '2.0.0', cliVersionAfterRun: '2.2.0' },
          cliOverride: ['npx --yes supabase@2.1.0'],
        },
      })
    );
    expect(metricsOf(check)).toMatchObject({
      relocatedHome: '/tmp/agent/.supabase',
      cliVersion: '2.0.0',
      cliVersionAfterRun: '2.2.0',
      cliOverride: ['npx --yes supabase@2.1.0'],
    });
  });

  it('leaves out cliVersionAfterRun when the PATH version did not move', async () => {
    const check = await checkMetrics(MARKER, metricsFacts());
    expect(metricsOf(check)).not.toHaveProperty('cliVersionAfterRun');
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
    const check = await checkMetrics(MARKER, metricsFacts({ stack: NO_STACK }));
    expect(metricsOf(check)).toMatchObject({
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

  it('reports an empty task table as 0 rather than unknown', async () => {
    const check = await checkMetrics(MARKER, metricsFacts({ taskRows: 0 }));
    expect(metricsOf(check).taskRows).toBe(0);
  });

  it('passes with nulls instead of failing when nothing could be read', async () => {
    const check = await checkMetrics(undefined, {
      commands: [],
      invocations: [],
      stack: NO_STACK,
      cli: NO_CLI,
      files: {
        seededMigrationModified: null,
        newMigrationFiles: null,
        declarativeSchemaFiles: null,
      },
      taskRows: null,
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
      workflowCommands: [],
      directDdlCommands: 0,
      cliDetours: 0,
      seededMigrationModified: null,
      newMigrationFiles: null,
      declarativeSchemaFiles: null,
      taskRows: null,
    });
  });

  it('keeps the other fields when the invocations cannot be read', async () => {
    const check = await checkMetrics(
      MARKER,
      metricsFacts({
        commands: [`psql "$DATABASE_URL" -c "${ADD_DUE_DATE_SQL}"`],
        invocations: unreadable<readonly SupabaseInvocation[]>(),
      })
    );
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      workflowCommands: null,
      directDdlCommands: 1,
      cliDetours: 0,
      taskRows: 3,
      newMigrationFiles: 1,
    });
  });

  it('keeps the invocation-based fields when the commands cannot be read', async () => {
    const check = await checkMetrics(
      MARKER,
      metricsFacts({
        commands: unreadable<readonly string[]>(),
        invocations: findSupabaseInvocations(['supabase start']),
      })
    );
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      workflowCommands: ['start'],
      directDdlCommands: null,
      cliDetours: null,
      taskRows: 3,
    });
  });
});
