// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-007-dump-before-push
import type { LocalStackEnvironmentMarker } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  activityOf,
  BASE_VERSION,
  DROP_STATEMENT,
  DROP_VERSION,
  FAKE_ACCESS_TOKEN,
  failedShellCall,
  file,
  HOSTED_REF,
  scanOf,
  shellCall,
} from './fixtures.js';
import { checkMetrics } from './metrics.js';
import type { Probe, RemoteState } from './remote.js';

type Facts = Parameters<typeof checkMetrics>[1];

const MARKER: LocalStackEnvironmentMarker = {
  runtime: 'local-stack',
  channel: 'stable',
  cliVersion: '2.122.0',
  docker: 'available',
  sessionStartedMs: 1_000,
};

const DUMP = 'supabase db dump --data-only -f backups/pre-drop.sql';
const PUSH = 'supabase db push --linked --yes';
const UP_TO_DATE = 'Remote database is up to date.';
const UNLINKED = 'Cannot find project ref. Have you run supabase link?';

const ok = <T>(value: T): Probe<T> => ({ ok: true, value });
const down = (notes: string): { ok: false; notes: string } => ({
  ok: false,
  notes,
});

const GOOD_STATE: RemoteState = {
  couponsTable: false,
  customersTable: true,
  customers: 8,
  seededCustomers: 8,
  dropStatements: DROP_STATEMENT,
};

const factsFor = (calls: Parameters<typeof activityOf>): Facts => ({
  hosted: true,
  history: ok([BASE_VERSION, DROP_VERSION]),
  state: ok(GOOD_STATE),
  scan: scanOf(file('backups/pre-drop.sql')),
  ...activityOf(...calls),
  cli: { cliVersion: '2.122.0' },
  commands: calls.map((call) =>
    typeof call === 'string' ? call : (call.command ?? '')
  ),
});

const FACTS = factsFor([DUMP, PUSH]);

const NO_ACTIVITY = {
  dbDump: 0,
  dbDumpDryRun: 0,
  dbDumpDataOnly: 0,
  dbDumpLocal: 0,
  dbDumpFailed: 0,
  dbDumpBeforePush: null,
  dbPush: 0,
  dbPushDryRun: 0,
  dbPushFailed: 0,
  dbPushUpToDate: 0,
  dbPushWithYes: 0,
  migrationList: 0,
  link: 0,
  login: 0,
};

const GOOD_METRICS = {
  hostedProject: true,
  remoteHasDropMigration: true,
  remoteCouponsDropped: true,
  remoteCustomers: 8,
  completeBackups: 1,
  bestBackupCodes: 15,
  bestBackupDates: 12,
  dbDump: 1,
  dbDumpDryRun: 0,
  dbDumpDataOnly: 1,
  dbDumpLocal: 0,
  dbDumpFailed: 0,
  dbDumpBeforePush: true,
  dbPush: 1,
  dbPushDryRun: 0,
  dbPushFailed: 0,
  dbPushUpToDate: 0,
  dbPushWithYes: 1,
  migrationList: 0,
  link: 0,
  login: 0,
  cliVersion: '2.122.0',
  runtime: 'local-stack',
  docker: 'available',
  commandCount: 2,
};

const metricsOf = async (
  facts: Facts,
  ...marker: [] | [LocalStackEnvironmentMarker | undefined]
) => {
  const check = await checkMetrics(
    marker.length === 0 ? MARKER : marker[0],
    facts
  );
  return JSON.parse(check.notes ?? '{}') as Record<string, unknown>;
};

const metricsFor = (...calls: Parameters<typeof activityOf>) =>
  metricsOf(factsFor(calls));

const without = (value: object, ...keys: string[]) =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key))
  );

const boom = () => {
  throw new Error('boom');
};

const exploding = <T>() =>
  new Proxy(
    {},
    {
      get: boom,
      has: boom,
      ownKeys: boom,
      getOwnPropertyDescriptor: boom,
    }
  ) as T;

describe('checkMetrics', () => {
  it('carries every documented field of a good run and passes', async () => {
    const check = await checkMetrics(MARKER, FACTS);

    expect(check).toMatchObject({ name: 'metrics', passed: true });
    expect(await metricsOf(FACTS)).toEqual(GOOD_METRICS);
  });

  it('passes with nulls and zeros when nothing worked', async () => {
    const facts: Facts = {
      hosted: false,
      history: down('no hosted project'),
      state: down('no hosted project'),
      scan: down('exit 1'),
      ...activityOf(),
      cli: { cliVersion: null },
      commands: [],
    };

    expect(await checkMetrics(undefined, facts)).toMatchObject({
      name: 'metrics',
      passed: true,
    });
    expect(await metricsOf(facts, undefined)).toEqual({
      hostedProject: false,
      remoteHasDropMigration: null,
      remoteCouponsDropped: null,
      remoteCustomers: null,
      completeBackups: null,
      bestBackupCodes: null,
      bestBackupDates: null,
      ...NO_ACTIVITY,
      cliVersion: null,
      runtime: null,
      docker: null,
      commandCount: 0,
    });
  });

  it('serialises the metrics as JSON in the notes', async () => {
    const check = await checkMetrics(MARKER, FACTS);

    expect(typeof check.notes).toBe('string');
    expect(() => JSON.parse(check.notes ?? '')).not.toThrow();
  });

  describe('hosted facts', () => {
    it('reports a missing drop migration as false, not null', async () => {
      expect(
        await metricsOf({ ...FACTS, history: ok([BASE_VERSION]) })
      ).toMatchObject({ remoteHasDropMigration: false });
    });

    it('reports an empty history as false, not null', async () => {
      expect(await metricsOf({ ...FACTS, history: ok([]) })).toMatchObject({
        remoteHasDropMigration: false,
      });
    });

    it('nulls only the history field when the history probe failed', async () => {
      expect(
        await metricsOf({ ...FACTS, history: down('connection refused') })
      ).toEqual({ ...GOOD_METRICS, remoteHasDropMigration: null });
    });

    it('nulls only the state fields when the state probe failed', async () => {
      expect(
        await metricsOf({ ...FACTS, state: down('connection refused') })
      ).toEqual({
        ...GOOD_METRICS,
        remoteCouponsDropped: null,
        remoteCustomers: null,
      });
    });

    it('reports a surviving coupons table as not dropped', async () => {
      expect(
        await metricsOf({
          ...FACTS,
          state: ok({ ...GOOD_STATE, couponsTable: true }),
        })
      ).toMatchObject({ remoteCouponsDropped: false, remoteCustomers: 8 });
    });

    it('reports zero customers, not null, for a hosted project that lost its rows', async () => {
      expect(
        await metricsOf({
          ...FACTS,
          state: ok({ ...GOOD_STATE, customers: 0, seededCustomers: 0 }),
        })
      ).toMatchObject({ remoteCustomers: 0 });
    });

    it('reports extra customer rows as the full count', async () => {
      expect(
        await metricsOf({
          ...FACTS,
          state: ok({ ...GOOD_STATE, customers: 9 }),
        })
      ).toMatchObject({ remoteCustomers: 9 });
    });

    it('reports null customers when the customers table is missing', async () => {
      expect(
        await metricsOf({
          ...FACTS,
          state: ok({
            couponsTable: false,
            customersTable: false,
            customers: null,
            seededCustomers: null,
            dropStatements: null,
          }),
        })
      ).toMatchObject({ remoteCouponsDropped: true, remoteCustomers: null });
    });

    it('keeps the counts and CLI facts when every hosted probe failed', async () => {
      expect(
        await metricsOf({
          ...FACTS,
          hosted: false,
          history: down('x'),
          state: down('x'),
        })
      ).toEqual({
        ...GOOD_METRICS,
        hostedProject: false,
        remoteHasDropMigration: null,
        remoteCouponsDropped: null,
        remoteCustomers: null,
      });
    });
  });

  describe('backup facts', () => {
    it.each([
      ['one complete file', [file('a.sql')], 1, 15, 12],
      [
        'two complete files and a partial one',
        [file('a.sql'), file('b.sql.gz'), file('c.sql', 4, 3)],
        2,
        15,
        12,
      ],
      ['only a partial file', [file('a.sql', 9, 8)], 0, 9, 8],
      [
        'the best of several partial files',
        [file('a.sql', 3, 2), file('b.sql', 14, 12), file('c.sql', 9, 8)],
        0,
        14,
        12,
      ],
      ['a file of the codes alone', [file('codes.csv', 15, 0)], 0, 15, 0],
      [
        'the dates of the file with the most codes, not the most dates',
        [file('a.sql', 15, 0), file('b.sql', 9, 12)],
        0,
        15,
        0,
      ],
      [
        'the most dates among files tied on codes',
        [file('a.sql', 9, 2), file('b.sql', 9, 7), file('c.sql', 9, 5)],
        0,
        9,
        7,
      ],
      ['a scan that found nothing', [], 0, 0, 0],
    ])(
      'counts %s',
      async (_, files, completeBackups, bestBackupCodes, bestBackupDates) => {
        expect(
          await metricsOf({ ...FACTS, scan: scanOf(...files) })
        ).toMatchObject({ completeBackups, bestBackupCodes, bestBackupDates });
      }
    );

    it('nulls the complete backups and best codes and dates when the scan failed', async () => {
      expect(
        await metricsOf({ ...FACTS, scan: down('exit 1: boom') })
      ).toMatchObject({
        completeBackups: null,
        bestBackupCodes: null,
        bestBackupDates: null,
      });
    });

    it('keeps zero and null apart, so a scan that found nothing is not read as a failed scan', async () => {
      const empty = await metricsOf({ ...FACTS, scan: scanOf() });
      const failed = await metricsOf({ ...FACTS, scan: down('boom') });

      expect(empty).toMatchObject({
        completeBackups: 0,
        bestBackupCodes: 0,
        bestBackupDates: 0,
      });
      expect(failed).toMatchObject({
        completeBackups: null,
        bestBackupCodes: null,
        bestBackupDates: null,
      });
    });
  });

  describe('dump facts', () => {
    it('counts nothing when no supabase command ran', async () => {
      expect(await metricsOf(factsFor([]))).toMatchObject(NO_ACTIVITY);
    });

    it('counts a plain dump as a dump only', async () => {
      expect(await metricsFor('supabase db dump -f x.sql')).toMatchObject({
        ...NO_ACTIVITY,
        dbDump: 1,
      });
    });

    it('counts a --data-only dump', async () => {
      expect(await metricsFor('supabase db dump --data-only')).toMatchObject({
        dbDump: 1,
        dbDumpDataOnly: 1,
      });
    });

    it('counts a dry run as a dump and as a dry run', async () => {
      expect(await metricsFor('supabase db dump --dry-run')).toMatchObject({
        dbDump: 1,
        dbDumpDryRun: 1,
      });
    });

    it.each([
      ['--local', 'supabase db dump --local -f x.sql'],
      [
        'a loopback --db-url',
        'supabase db dump --db-url "postgresql://postgres:postgres@127.0.0.1:54322/postgres"',
      ],
    ])('counts a dump with %s as local', async (_, command) => {
      expect(await metricsFor(command)).toMatchObject({
        dbDump: 1,
        dbDumpLocal: 1,
      });
    });

    it('does not count a --linked dump as local', async () => {
      expect(await metricsFor('supabase db dump --linked')).toMatchObject({
        dbDump: 1,
        dbDumpLocal: 0,
      });
    });

    it('counts a role-only dump as a dump and not as a data-only one', async () => {
      expect(
        await metricsFor('supabase db dump --role-only -f roles.sql')
      ).toMatchObject({ dbDump: 1, dbDumpDataOnly: 0 });
    });

    it('counts a dump whose tool call errored, or whose piped output shows the CLI failing, as failed', async () => {
      expect(
        await metricsFor(
          failedShellCall(DUMP),
          shellCall('supabase db dump 2>&1 | head -50', { result: UNLINKED }),
          shellCall('supabase db dump 2>&1 | head -50', {
            result: 'pg_dump: error: connection refused',
          }),
          shellCall(DUMP, { result: 'Dumped schema to backups/pre-drop.sql' })
        )
      ).toMatchObject({ dbDump: 4, dbDumpFailed: 3, dbDumpDataOnly: 2 });
    });

    it('counts every dump of a chained command and across commands', async () => {
      expect(
        await metricsFor(
          'supabase db dump --role-only -f r.sql && supabase db dump --data-only -f d.sql',
          'supabase db dump --dry-run',
          'npx supabase db dump --linked -f x.sql'
        )
      ).toMatchObject({
        dbDump: 4,
        dbDumpDryRun: 1,
        dbDumpDataOnly: 1,
        dbDumpLocal: 0,
        dbDumpFailed: 0,
      });
    });
  });

  describe('push facts', () => {
    it('counts a push without --yes as a push only', async () => {
      expect(await metricsFor('supabase db push')).toMatchObject({
        ...NO_ACTIVITY,
        dbPush: 1,
      });
    });

    it.each(['--yes', '--yes=true'])(
      'counts db push %s as a push with --yes',
      async (flag) => {
        expect(
          await metricsFor(`supabase db push --linked ${flag}`)
        ).toMatchObject({ dbPush: 1, dbPushWithYes: 1 });
      }
    );

    it('does not count --yes=false or a piped answer as a push with --yes', async () => {
      expect(
        await metricsFor(
          'supabase db push --yes=false',
          'yes | supabase db push'
        )
      ).toMatchObject({ dbPush: 2, dbPushWithYes: 0 });
    });

    it('counts a dry run as a push and as a dry run', async () => {
      expect(await metricsFor('supabase db push --dry-run')).toMatchObject({
        dbPush: 1,
        dbPushDryRun: 1,
      });
    });

    it('counts a push whose tool call errored or whose output shows the CLI failing as failed', async () => {
      expect(
        await metricsFor(
          failedShellCall(PUSH),
          shellCall('supabase db push 2>&1 | tail -5', { result: UNLINKED }),
          shellCall('supabase db push', {
            result: 'Finished supabase db push.',
          })
        )
      ).toMatchObject({ dbPush: 3, dbPushFailed: 2, dbPushWithYes: 1 });
    });

    it.each([
      ['text', UP_TO_DATE],
      ['JSON', '{"data":{"upToDate":true}}'],
    ])(
      'counts a push whose %s output says it was up to date',
      async (_, result) => {
        expect(
          await metricsFor(
            shellCall('supabase db push', { result }),
            shellCall('supabase db push', {
              result: 'Finished supabase db push.',
            })
          )
        ).toMatchObject({ dbPush: 2, dbPushUpToDate: 1 });
      }
    );

    it('does not count a dump as a push, or a push as a dump', async () => {
      expect(await metricsFor(DUMP, PUSH)).toMatchObject({
        dbDump: 1,
        dbPush: 1,
      });
      expect(await metricsFor(DUMP)).toMatchObject({ dbDump: 1, dbPush: 0 });
      expect(await metricsFor(PUSH)).toMatchObject({ dbDump: 0, dbPush: 1 });
    });
  });

  describe('dbDumpBeforePush', () => {
    it.each([
      ['a dump, then a push', [DUMP, PUSH], true],
      ['a push, then a dump', [PUSH, DUMP], false],
      [
        'a dump and a push in one chained command',
        [`${DUMP} && ${PUSH}`],
        true,
      ],
      [
        'a push and a dump in one chained command',
        [`${PUSH} && ${DUMP}`],
        false,
      ],
      [
        'a dump before a push and another dump after it',
        [DUMP, PUSH, 'supabase db dump -f after.sql'],
        true,
      ],
      ['a push, a dump, then another push', [PUSH, DUMP, PUSH], false],
      [
        'a dump that failed, a push, then a dump that worked',
        [failedShellCall(DUMP), PUSH, DUMP],
        false,
      ],
      [
        'a dump that failed, a dump that worked, then a push',
        [failedShellCall(DUMP), DUMP, PUSH],
        true,
      ],
      [
        'a dry-run push before the dump and a push after it',
        ['supabase db push --dry-run --linked', DUMP, PUSH],
        true,
      ],
      [
        'a dump before a dry-run push and the push',
        [DUMP, 'supabase db push --dry-run', PUSH],
        true,
      ],
      [
        'a failed push before the dump and a push after it',
        [failedShellCall(PUSH), DUMP, PUSH],
        true,
      ],
      [
        'a local push before the dump and a push after it',
        ['supabase db push --local', DUMP, PUSH],
        true,
      ],
    ] as [string, Parameters<typeof activityOf>, boolean][])(
      'reports dbDumpBeforePush for %s',
      async (_, calls, expected) => {
        expect(await metricsFor(...calls)).toMatchObject({
          dbDumpBeforePush: expected,
        });
      }
    );

    it.each([
      ['a dump and no push', [DUMP]],
      ['a push and no dump', [PUSH]],
      ['nothing', []],
      ['only a dry-run dump and a push', ['supabase db dump --dry-run', PUSH]],
      [
        'only a role-only dump and a push',
        ['supabase db dump --role-only -f r.sql', PUSH],
      ],
      [
        'only a local dump and a push',
        ['supabase db dump --local -f x.sql', PUSH],
      ],
      ['only a failed dump and a push', [failedShellCall(DUMP), PUSH]],
      ['a dump and only a dry-run push', [DUMP, 'supabase db push --dry-run']],
      ['a dump and only a local push', [DUMP, 'supabase db push --local']],
      ['a dump and only a failed push', [DUMP, failedShellCall(PUSH)]],
      [
        'a dump and only an up-to-date push',
        [DUMP, shellCall(PUSH, { result: UP_TO_DATE })],
      ],
    ] as [string, Parameters<typeof activityOf>][])(
      'reports dbDumpBeforePush as null for %s, as there is no credited pair to order',
      async (_, calls) => {
        expect(await metricsFor(...calls)).toMatchObject({
          dbDumpBeforePush: null,
        });
      }
    );
  });

  describe('other invocations', () => {
    it('counts migration list with and without a target, and not other migration verbs', async () => {
      expect(
        await metricsFor(
          'supabase migration list',
          'supabase migration list --linked',
          'supabase migration up',
          'supabase migration repair --status applied 1'
        )
      ).toMatchObject({ migrationList: 2 });
    });

    it('counts supabase link --project-ref as a link', async () => {
      expect(
        await metricsFor(`supabase link --project-ref ${HOSTED_REF}`)
      ).toMatchObject({ link: 1, login: 0 });
    });

    it('counts supabase login --token as a login', async () => {
      expect(
        await metricsFor(`supabase login --token ${FAKE_ACCESS_TOKEN}`)
      ).toMatchObject({ link: 0, login: 1 });
    });

    it.each([
      ['an echoed command line', 'echo "supabase db push --yes"'],
      ['a help request', 'supabase db dump --help'],
      ['db reset', 'supabase db reset --linked'],
      ['db pull', 'supabase db pull'],
      ['db query', 'supabase db query --linked "select 1"'],
      ['pg_dump', 'pg_dump "$DB_URL" > backups/x.sql'],
    ])('does not count %s', async (_, command) => {
      expect(await metricsFor(command)).toMatchObject(NO_ACTIVITY);
    });

    it('counts every invocation of a chained command and across commands', async () => {
      expect(
        await metricsFor(
          `supabase link --project-ref ${HOSTED_REF} && supabase db dump --data-only -f x.sql && supabase db push --dry-run --linked && supabase db push --linked --yes`,
          'supabase migration list --linked',
          `supabase login --token ${FAKE_ACCESS_TOKEN}`
        )
      ).toMatchObject({
        dbDump: 1,
        dbDumpDataOnly: 1,
        dbDumpBeforePush: true,
        dbPush: 2,
        dbPushDryRun: 1,
        dbPushWithYes: 1,
        migrationList: 1,
        link: 1,
        login: 1,
        commandCount: 3,
      });
    });
  });

  describe('CLI and environment facts', () => {
    it('reports the CLI version PATH resolved to after the run when it differs', async () => {
      expect(
        await metricsOf({
          ...FACTS,
          cli: { cliVersion: '2.122.0', cliVersionAfterRun: '2.123.0' },
        })
      ).toMatchObject({
        cliVersion: '2.122.0',
        cliVersionAfterRun: '2.123.0',
      });
    });

    it('leaves out cliVersionAfterRun when the CLI facts have none', async () => {
      expect(await metricsOf(FACTS)).not.toHaveProperty('cliVersionAfterRun');
    });

    it('reports a null CLI version when none was found', async () => {
      expect(
        await metricsOf({ ...FACTS, cli: { cliVersion: null } })
      ).toMatchObject({ cliVersion: null });
    });

    it('reports the runtime and docker facts from the environment marker', async () => {
      expect(
        await metricsOf(FACTS, { ...MARKER, docker: 'no-daemon' })
      ).toMatchObject({ runtime: 'local-stack', docker: 'no-daemon' });
    });

    it('reports null runtime and docker when there is no marker', async () => {
      expect(await metricsOf(FACTS, undefined)).toMatchObject({
        runtime: null,
        docker: null,
      });
    });

    it('counts the commands the agent ran', async () => {
      expect(
        await metricsOf({ ...FACTS, commands: ['a', 'b', 'c', 'd', 'e'] })
      ).toMatchObject({ commandCount: 5 });
      expect(await metricsOf({ ...FACTS, commands: [] })).toMatchObject({
        commandCount: 0,
      });
    });
  });

  describe('independence', () => {
    it.each([
      [
        'history',
        { history: exploding<Facts['history']>() },
        { remoteHasDropMigration: null },
      ],
      [
        'state',
        { state: exploding<Facts['state']>() },
        { remoteCouponsDropped: null, remoteCustomers: null },
      ],
      [
        'dumps',
        { dumps: exploding<Facts['dumps']>() },
        {
          dbDump: null,
          dbDumpDryRun: null,
          dbDumpDataOnly: null,
          dbDumpLocal: null,
          dbDumpFailed: null,
          dbDumpBeforePush: null,
        },
      ],
      [
        'pushes',
        { pushes: exploding<Facts['pushes']>() },
        {
          dbPush: null,
          dbPushDryRun: null,
          dbPushFailed: null,
          dbPushUpToDate: null,
          dbPushWithYes: null,
          dbDumpBeforePush: null,
        },
      ],
      [
        'invocations',
        { invocations: exploding<Facts['invocations']>() },
        { migrationList: null, link: null, login: null },
      ],
      [
        'commands',
        { commands: exploding<Facts['commands']>() },
        { commandCount: null },
      ],
    ] as [string, Partial<Facts>, Record<string, null>][])(
      'nulls only the fields read from the %s fact when reading it throws',
      async (_, override, nulls) => {
        const check = await checkMetrics(MARKER, { ...FACTS, ...override });

        expect(check).toMatchObject({ name: 'metrics', passed: true });
        expect(JSON.parse(check.notes ?? '{}')).toEqual({
          ...GOOD_METRICS,
          ...nulls,
        });
      }
    );

    it('nulls the backup fields and keeps the rest when reading the scan throws', async () => {
      const check = await checkMetrics(MARKER, {
        ...FACTS,
        scan: exploding<Facts['scan']>(),
      });

      expect(check.passed).toBe(true);
      expect(JSON.parse(check.notes ?? '{}')).toMatchObject(
        without(
          GOOD_METRICS,
          'completeBackups',
          'bestBackupCodes',
          'bestBackupDates'
        )
      );
      expect(JSON.parse(check.notes ?? '{}').bestBackupCodes).toBeNull();
      expect(JSON.parse(check.notes ?? '{}').bestBackupDates).toBeNull();
    });

    it('keeps every other field when reading the CLI facts throws', async () => {
      const check = await checkMetrics(MARKER, {
        ...FACTS,
        cli: exploding<Facts['cli']>(),
      });

      expect(check.passed).toBe(true);
      expect(JSON.parse(check.notes ?? '{}')).toMatchObject(
        without(GOOD_METRICS, 'cliVersion')
      );
    });

    it('nulls the runtime fields and keeps the rest when reading the marker throws', async () => {
      const check = await checkMetrics(
        exploding<LocalStackEnvironmentMarker>(),
        FACTS
      );

      expect(check.passed).toBe(true);
      expect(JSON.parse(check.notes ?? '{}')).toEqual({
        ...GOOD_METRICS,
        runtime: null,
        docker: null,
      });
    });

    it('still passes, with valid JSON notes, when every fact throws', async () => {
      const check = await checkMetrics(
        exploding<LocalStackEnvironmentMarker>(),
        {
          hosted: true,
          history: exploding<Facts['history']>(),
          state: exploding<Facts['state']>(),
          scan: exploding<Facts['scan']>(),
          dumps: exploding<Facts['dumps']>(),
          pushes: exploding<Facts['pushes']>(),
          invocations: exploding<Facts['invocations']>(),
          cli: exploding<Facts['cli']>(),
          commands: exploding<Facts['commands']>(),
        }
      );

      expect(check).toMatchObject({ name: 'metrics', passed: true });
      expect(JSON.parse(check.notes ?? '')).toMatchObject({
        hostedProject: true,
        remoteHasDropMigration: null,
        dbDump: null,
        dbPush: null,
        commandCount: null,
      });
    });
  });

  it('always passes, even when every fact is missing', async () => {
    expect(
      (
        await checkMetrics(undefined, {
          hosted: false,
          history: down('x'),
          state: down('x'),
          scan: down('x'),
          ...activityOf(),
          cli: { cliVersion: null },
          commands: [],
        })
      ).passed
    ).toBe(true);
  });
});
