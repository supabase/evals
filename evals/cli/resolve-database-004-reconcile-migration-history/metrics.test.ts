// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/resolve-database-004-reconcile-migration-history
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
import type { LocalMigrationsProbe } from './local.js';
import {
  checkMetrics,
  countCliCommands,
  countHistorySqlWrites,
  readCliFacts,
} from './metrics.js';
import { NO_HOSTED_PROJECT, type RemoteProbe } from './remote.js';

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'beta',
  cliVersion: '2.0.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

function commandResult(stdout: string, ok = true): CommandResult {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'error' };
}

const ctx: Pick<LocalStackEvalContext, 'exec'> = {
  exec: async (command) =>
    command.endsWith('supabase --version')
      ? commandResult('2.0.0\n')
      : commandResult('', false),
};

const LOCAL: LocalMigrationsProbe = {
  ok: true,
  migrations: [
    {
      file: '20240101000000_create_profiles.sql',
      version: '20240101000000',
      changes: ['profiles'],
    },
    {
      file: '20240116120000_add_profile_bio.sql',
      version: '20240116120000',
      changes: ['bio'],
    },
  ],
};

const REMOTE: RemoteProbe = {
  ok: true,
  state: {
    versions: ['20240101000000', '20240115093000', '20240201000000'],
    profileColumns: ['id', 'username', 'created_at', 'bio'],
    postsExists: true,
    profileRows: 25,
    intactBios: 25,
    postRows: 40,
  },
};

const NO_HOSTED: RemoteProbe = { ok: false, notes: NO_HOSTED_PROJECT };

const metricsOf = (check: { notes?: string }) =>
  JSON.parse(check.notes ?? '{}');

const countOf = (commands: string[]) =>
  countCliCommands(findSupabaseInvocations(commands));

const total = (counts: Record<string, number>) =>
  Object.values(counts).reduce((sum, n) => sum + n, 0);

describe('countCliCommands', () => {
  it('counts each reconciliation subcommand under its own key', () => {
    const counts = countOf([
      'supabase migration list',
      'supabase migration list --linked',
      'supabase migration repair --status reverted 20240115093000',
      'supabase migration repair --status applied 20240116120000',
      'supabase migration repair --status applied 20240301000000',
      'supabase migration fetch',
      'supabase db push',
      'supabase db pull',
      'supabase link --project-ref abcdefghijklmnopqrst',
      'supabase login --token sbp_x',
    ]);
    expect(counts['migration list']).toBe(2);
    expect(counts['migration repair']).toBe(3);
    expect(counts['migration fetch']).toBe(1);
    expect(counts['db push']).toBe(1);
    expect(counts['db pull']).toBe(1);
    expect(counts.link).toBe(1);
    expect(counts.login).toBe(1);
    expect(total(counts)).toBe(10);
  });

  it('counts the migrations alias under migration', () => {
    const counts = countOf([
      'supabase migrations list',
      'supabase migration list',
      'supabase migrations repair --status applied 20240116120000',
    ]);
    expect(counts['migration list']).toBe(2);
    expect(counts['migration repair']).toBe(1);
    expect(counts.migrations).toBeUndefined();
    expect(total(counts)).toBe(3);
  });

  it('ignores flags when keying a command', () => {
    const counts = countOf([
      'supabase --debug migration list',
      'supabase db push --linked --dry-run',
      'supabase db --debug pull',
      'supabase migration repair --status applied --linked 20240116120000',
    ]);
    expect(counts['migration list']).toBe(1);
    expect(counts['db push']).toBe(1);
    expect(counts['db pull']).toBe(1);
    expect(counts['migration repair']).toBe(1);
    expect(total(counts)).toBe(4);
  });

  it('counts db query under its own key', () => {
    const counts = countOf([
      'supabase db query "select 1"',
      'supabase db query --linked "select version from supabase_migrations.schema_migrations"',
    ]);
    expect(counts['db query']).toBe(2);
    expect(counts.other).toBeUndefined();
  });

  it.each([
    ['supabase --workdir app migration list', 'migration list'],
    ['supabase --workdir=app migration list', 'migration list'],
    ['supabase --profile staging db push', 'db push'],
    ['supabase --network-id net db pull', 'db pull'],
    ['supabase -o json migration list', 'migration list'],
    ['supabase --output json migration list', 'migration list'],
    ['supabase --dns-resolver https migration fetch', 'migration fetch'],
    ['supabase db --db-url postgres://x push', 'db push'],
    [
      'supabase migration --project-ref abcdefghijklmnopqrst list',
      'migration list',
    ],
    ['supabase db -p secret pull', 'db pull'],
    ['supabase db --password secret pull', 'db pull'],
    ['supabase db diff --schema public', 'other'],
    ['supabase db -s public query "select 1"', 'db query'],
    [
      'supabase migration repair --status reverted 20240115093000',
      'migration repair',
    ],
    [
      'supabase migration repair --status applied 20240116120000',
      'migration repair',
    ],
    [
      'supabase --workdir app migration repair --status=reverted 20240115093000',
      'migration repair',
    ],
    ['supabase --workdir app', 'other'],
  ])('keys %s as %s', (command, key) => {
    expect(countOf([command])).toEqual({ [key]: 1 });
  });

  it('files every other subcommand under other', () => {
    const counts = countOf([
      'supabase db reset --linked',
      'supabase db diff',
      'supabase migration up',
      'supabase migration new add_notes',
      'supabase start',
      'supabase stack list',
      'supabase inspect db bloat',
      'supabase',
    ]);
    expect(counts.other).toBe(8);
    expect(counts['migration list'] ?? 0).toBe(0);
    expect(counts['db push'] ?? 0).toBe(0);
    expect(total(counts)).toBe(8);
  });

  it('does not count --help invocations or commands that are not the supabase CLI', () => {
    const counts = countOf([
      'supabase migration repair --help',
      'supabase db push -h',
      'psql "$DB_URL" -c "select 1"',
      'echo supabase migration list',
      'ls supabase/migrations',
    ]);
    expect(total(counts)).toBe(0);
  });

  it('counts a command run through a shell wrapper and chained commands separately', () => {
    const counts = countOf([
      "bash -lc 'supabase migration list'",
      'supabase migration fetch && supabase migration list',
    ]);
    expect(counts['migration list']).toBe(2);
    expect(counts['migration fetch']).toBe(1);
    expect(total(counts)).toBe(3);
  });

  it('returns no counts when there are no invocations', () => {
    expect(total(countCliCommands([]))).toBe(0);
  });
});

describe('countHistorySqlWrites', () => {
  const edit = (sql: string, prefix = 'psql "$DB_URL" -c') =>
    `${prefix} "${sql}"`;
  const TABLE = 'supabase_migrations.schema_migrations';

  it.each([
    ['delete', edit(`delete from ${TABLE} where version = '20240115093000'`)],
    [
      'insert',
      edit(
        `insert into ${TABLE} (version, name) values ('20240116120000', 'add_profile_bio')`
      ),
    ],
    ['update', edit(`update ${TABLE} set name = 'x'`)],
    ['truncate', edit(`truncate ${TABLE}`)],
    ['truncate table', edit(`truncate table ${TABLE}`)],
    ['uppercase', edit(`DELETE FROM ${TABLE}`)],
    [
      'quoted identifiers',
      `psql "$DB_URL" -c 'delete from "supabase_migrations"."schema_migrations" where true'`,
    ],
    ['multi-line statement', edit(`delete\nfrom ${TABLE}`)],
    [
      'environment prefix',
      edit(`delete from ${TABLE}`, 'PGPASSWORD=x psql -h db.example.com -c'),
    ],
    ['shell wrapper', `bash -lc 'psql "$DB_URL" -c "delete from ${TABLE}"'`],
  ])('counts a psql %s of the migration history', (_label, command) => {
    expect(countHistorySqlWrites([command])).toBe(1);
  });

  it('counts a command once however many history writes it holds', () => {
    expect(
      countHistorySqlWrites([
        edit(
          `delete from ${TABLE} where version = '1'; insert into ${TABLE} (version) values ('2')`
        ),
        `${edit(`delete from ${TABLE}`)} && ${edit(`insert into ${TABLE} (version) values ('2')`)}`,
      ])
    ).toBe(2);
  });

  it('counts each separate command', () => {
    expect(
      countHistorySqlWrites([
        edit(`delete from ${TABLE}`),
        'ls',
        edit(`insert into ${TABLE} (version) values ('2')`),
      ])
    ).toBe(2);
  });

  it('does not count supabase migration repair', () => {
    expect(
      countHistorySqlWrites([
        'supabase migration repair --status reverted 20240115093000 20240201000000',
        'supabase migration repair --status applied 20240116120000',
      ])
    ).toBe(0);
  });

  it.each([
    [
      'supabase db query',
      `supabase db query "delete from ${TABLE} where version = '1'"`,
    ],
    [
      'supabase db query --linked',
      `supabase db query --linked "insert into ${TABLE} (version) values ('2')"`,
    ],
    ['npx supabase db query', `npx supabase db query "truncate ${TABLE}"`],
    [
      'npx with a pinned version',
      `npx --yes supabase@2.121.0 db query "update ${TABLE} set name = 'x'"`,
    ],
    ['a shell wrapper', `bash -lc 'supabase db query "delete from ${TABLE}"'`],
    ['psql -c', `psql "$DB_URL" -c "delete from ${TABLE}"`],
    ['psql --command', `psql "$DB_URL" --command "truncate ${TABLE}"`],
  ])('counts %s writing the migration history', (_label, command) => {
    expect(countHistorySqlWrites([command])).toBe(1);
  });

  it('counts a command once when a supabase db query and a psql both write the history', () => {
    expect(
      countHistorySqlWrites([
        `supabase db query "delete from ${TABLE}" && ${edit(`insert into ${TABLE} (version) values ('2')`)}`,
      ])
    ).toBe(1);
  });

  it('does not count a supabase db query that only reads the history', () => {
    expect(
      countHistorySqlWrites([
        `supabase db query --linked "select version from ${TABLE} order by version"`,
        `npx supabase db query "select count(*) from ${TABLE}"`,
      ])
    ).toBe(0);
  });

  it('does not count reads of the migration history', () => {
    expect(
      countHistorySqlWrites([
        edit(`select version from ${TABLE} order by version`),
        edit(`select count(*) from ${TABLE}`),
      ])
    ).toBe(0);
  });

  it('does not count writes to other tables or look-alike history tables', () => {
    expect(
      countHistorySqlWrites([
        edit(`delete from public.schema_migrations`),
        edit(`delete from supabase_migrations.seed_files`),
        edit(`delete from public.profiles where username = 'a'`),
        edit(`insert into public.posts (title) values ('a')`),
        edit(`update ${TABLE}_archive set name = 'x'`),
      ])
    ).toBe(0);
  });

  it('does not count history SQL that only appears in a shell comment', () => {
    expect(
      countHistorySqlWrites([
        `# delete from ${TABLE}\nls`,
        `ls # truncate ${TABLE}`,
        `${edit('select 1')} # delete from ${TABLE}`,
      ])
    ).toBe(0);
  });

  it('returns zero for no commands', () => {
    expect(countHistorySqlWrites([])).toBe(0);
  });
});

describe('readCliFacts', () => {
  it('reads the staged CLI version and no override for a plain run', async () => {
    const invocations = findSupabaseInvocations(['supabase migration list']);
    expect(await readCliFacts(ctx, MARKER, invocations)).toEqual({
      versions: { cliVersion: '2.0.0' },
      cliOverride: [],
    });
  });

  it('reports a version-swapping runner and a PATH version that moved', async () => {
    const moved: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async (command) =>
        command.startsWith('/usr/bin/supabase')
          ? commandResult('2.0.0\n')
          : commandResult('2.2.0\n'),
    };
    const invocations = findSupabaseInvocations([
      'npx --yes supabase@2.1.0 migration list',
    ]);
    expect(await readCliFacts(moved, MARKER, invocations)).toEqual({
      versions: { cliVersion: '2.0.0', cliVersionAfterRun: '2.2.0' },
      cliOverride: ['npx --yes supabase@2.1.0'],
    });
  });
});

describe('checkMetrics', () => {
  const commands = [
    'supabase login --token sbp_x',
    'supabase link --project-ref abcdefghijklmnopqrst',
    'supabase migration list',
    'supabase migration repair --status reverted 20240115093000',
    'supabase db query --linked "select 1"',
    'psql "$DB_URL" -c "delete from supabase_migrations.schema_migrations"',
    'sudo apt-get install docker.io',
  ];

  it('reports every field and always passes', async () => {
    const invocations = findSupabaseInvocations(commands);
    const check = await checkMetrics(MARKER, {
      commands,
      invocations,
      local: LOCAL,
      remote: REMOTE,
      hosted: true,
      cli: await readCliFacts(ctx, MARKER, invocations),
    });
    expect(check).toMatchObject({ name: 'metrics', passed: true });
    const metrics = metricsOf(check);
    expect(Object.keys(metrics).sort()).toEqual([
      'channel',
      'cliCommands',
      'cliDetours',
      'cliOverride',
      'cliVersion',
      'historySqlWrites',
      'hostedProject',
      'localMigrations',
      'remoteVersions',
    ]);
    expect(metrics).toMatchObject({
      cliVersion: '2.0.0',
      cliOverride: [],
      channel: 'beta',
      hostedProject: true,
      localMigrations: [
        '20240101000000_create_profiles.sql',
        '20240116120000_add_profile_bio.sql',
      ],
      remoteVersions: ['20240101000000', '20240115093000', '20240201000000'],
      cliCommands: {
        login: 1,
        link: 1,
        'migration list': 1,
        'migration repair': 1,
        'db query': 1,
      },
      historySqlWrites: 1,
      cliDetours: 1,
    });
  });

  it('reports nulls instead of failing when nothing could be read', async () => {
    const failing: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async () => {
        throw new Error('sandbox gone');
      },
    };
    const check = await checkMetrics(undefined, {
      commands: [],
      invocations: [],
      local: { ok: false, notes: 'ls failed' },
      remote: NO_HOSTED,
      hosted: false,
      cli: await readCliFacts(failing, undefined, []),
    });
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      cliVersion: null,
      channel: 'pinned',
      hostedProject: false,
      localMigrations: null,
      remoteVersions: null,
      historySqlWrites: 0,
      cliDetours: 0,
    });
  });

  it('reports a PATH version that moved and the override runner', async () => {
    const moved: Pick<LocalStackEvalContext, 'exec'> = {
      exec: async (command) =>
        command.startsWith('/usr/bin/supabase')
          ? commandResult('2.0.0\n')
          : commandResult('2.2.0\n'),
    };
    const runnerCommands = ['npx --yes supabase@2.1.0 migration list'];
    const invocations = findSupabaseInvocations(runnerCommands);
    const check = await checkMetrics(MARKER, {
      commands: runnerCommands,
      invocations,
      local: LOCAL,
      remote: REMOTE,
      hosted: true,
      cli: await readCliFacts(moved, MARKER, invocations),
    });
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      cliVersionAfterRun: '2.2.0',
      cliOverride: ['npx --yes supabase@2.1.0'],
    });
  });

  it('omits cliVersionAfterRun when the PATH version did not move', async () => {
    const check = await checkMetrics(MARKER, {
      commands: [],
      invocations: [],
      local: LOCAL,
      remote: REMOTE,
      hosted: true,
      cli: await readCliFacts(ctx, MARKER, []),
    });
    expect(metricsOf(check)).not.toHaveProperty('cliVersionAfterRun');
  });

  it('keeps the other fields when computing one of them throws', async () => {
    const throwingLocal = {
      ok: true,
      get migrations(): never {
        throw new Error('listing unreadable');
      },
    } as unknown as LocalMigrationsProbe;
    const throwingRemote = {
      ok: true,
      state: {
        ...(REMOTE.ok ? REMOTE.state : {}),
        get versions(): never {
          throw new Error('versions unreadable');
        },
      },
    } as unknown as RemoteProbe;
    const invocations = findSupabaseInvocations(commands);
    const check = await checkMetrics(MARKER, {
      commands,
      invocations,
      local: throwingLocal,
      remote: throwingRemote,
      hosted: true,
      cli: await readCliFacts(ctx, MARKER, invocations),
    });
    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      hostedProject: true,
      localMigrations: null,
      remoteVersions: null,
      cliCommands: { 'migration list': 1 },
      historySqlWrites: 1,
      cliDetours: 1,
    });
  });

  it('keeps the other fields when the invocations cannot be counted', async () => {
    const check = await checkMetrics(MARKER, {
      commands,
      invocations: [null] as unknown as SupabaseInvocation[],
      local: LOCAL,
      remote: REMOTE,
      hosted: true,
      cli: await readCliFacts(ctx, MARKER, []),
    });
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      historySqlWrites: 1,
      cliDetours: 1,
      localMigrations: [
        '20240101000000_create_profiles.sql',
        '20240116120000_add_profile_bio.sql',
      ],
    });
  });

  it('keeps the other fields when the commands cannot be scanned', async () => {
    const check = await checkMetrics(MARKER, {
      commands: [undefined] as unknown as string[],
      invocations: [],
      local: LOCAL,
      remote: REMOTE,
      hosted: true,
      cli: await readCliFacts(ctx, MARKER, []),
    });
    expect(check.passed).toBe(true);
    expect(metricsOf(check)).toMatchObject({
      cliVersion: '2.0.0',
      hostedProject: true,
      historySqlWrites: null,
      cliDetours: null,
    });
  });
});
