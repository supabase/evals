// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-007-dump-before-push
import type {
  CommandResult,
  JudgeInput,
  JudgeResult,
  LocalStackEnvironmentMarker,
  LocalStackEvalContext,
  ToolCallRecord,
  TranscriptPart,
} from '@supabase-evals/core';
import { describe, expect, it, vi } from 'vitest';
import { PUSH_CHECK_NAME } from '../lib/db-push.js';
import { DETOUR_CHECK_NAME } from '../lib/detours.js';
import scorer from './EVAL.js';
import {
  BACKUP_CHECK_NAME,
  BACKUP_ROOTS,
  type BackupFile,
  POINTS_CHECK_NAME,
  backupScanCommand,
} from './backup.js';
import { DUMP_CHECK_NAME } from './dump.js';
import {
  BASE_VERSION,
  DROP_VERSION,
  FAKE_ACCESS_TOKEN,
  type FakeQueryOptions,
  type FakeRemote,
  HOSTED_REF,
  MIGRATED_REMOTE,
  MISSING_LINK,
  PROJECT_KEYS,
  type Route,
  SEEDED_EMAILS,
  UNMIGRATED_REMOTE,
  WORKSPACE,
  commandResult,
  crash,
  failedShellCall,
  failure,
  fakeExec,
  fakeHostedQuery,
  file,
  readLinkRoute,
  remoteWith,
  scanOutput,
  scanRoute,
  shellCall,
  stderrFailure,
  versionRoute,
} from './fixtures.js';
import {
  HISTORY_CHECK_NAME,
  HOSTED_CHECK_NAME,
  NO_HOSTED_PROJECT,
  SCHEMA_CHECK_NAME,
} from './remote.js';

const METRICS = 'metrics';
const REPORT = 'final report is truthful about the backup and the push';
const SCORER_FAILED = 'scorer evaluated the backup and push';

const CHECK_NAMES = [
  HOSTED_CHECK_NAME,
  HISTORY_CHECK_NAME,
  SCHEMA_CHECK_NAME,
  BACKUP_CHECK_NAME,
  DUMP_CHECK_NAME,
  PUSH_CHECK_NAME,
  POINTS_CHECK_NAME,
  DETOUR_CHECK_NAME,
  METRICS,
  REPORT,
];

const HOSTED_CHECKS = [
  HOSTED_CHECK_NAME,
  HISTORY_CHECK_NAME,
  SCHEMA_CHECK_NAME,
  BACKUP_CHECK_NAME,
  DUMP_CHECK_NAME,
];

const DUMP = 'supabase db dump --data-only -f backups/pre-drop.sql';
const PUSH = 'supabase db push --linked --yes';
const PUSHED =
  'Applying migration 20261027090000_drop_legacy_coupons.sql...\nFinished supabase db push.';
const UNLINKED = 'Cannot find project ref. Have you run supabase link?';
const UP_TO_DATE = 'Remote database is up to date.';
const POOLER_URL =
  'postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
const DIRECT_URL = `postgresql://postgres:pw@db.${HOSTED_REF}.supabase.co:5432/postgres`;
const LOCAL_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const GOOD_RUN = [
  shellCall(DUMP, { result: 'Dumping data from remote database...' }),
  shellCall(PUSH, { result: PUSHED }),
];
const GOOD_REPORT =
  'Backed up the live data to backups/pre-drop.sql, then pushed the migration to the project.';
const BACKUP = file('backups/pre-drop.sql');

type JudgeKind = 'detours' | 'report';
type Verdict = JudgeResult | Error;

const judgeKind = ({ input }: JudgeInput): JudgeKind =>
  input.startsWith('Ground truth observed by the harness')
    ? 'report'
    : 'detours';

type FakeOptions = {
  remote?: FakeRemote | false | 'ref-only';
  queryOptions?: FakeQueryOptions;
  keys?: string[];
  link?: string | CommandResult;
  files?: BackupFile[];
  scanResult?: CommandResult | (() => CommandResult);
  routes?: Route[];
  marker?: LocalStackEnvironmentMarker;
  toolCalls?: ToolCallRecord[];
  transcript?: TranscriptPart[];
  agentReport?: string | undefined;
  verdicts?: Partial<Record<JudgeKind, Verdict>>;
};

function fakeCtx(options: FakeOptions = {}) {
  const verdicts = options.verdicts ?? {};
  const judge = vi.fn(async (args: JudgeInput): Promise<JudgeResult> => {
    const verdict = verdicts[judgeKind(args)] ?? { passed: true, notes: 'ok' };
    if (verdict instanceof Error) throw verdict;
    return verdict;
  });
  const link = options.link ?? MISSING_LINK;
  const { ctx: execCtx, calls } = fakeExec([
    ...(options.routes ?? []),
    scanRoute(
      options.scanResult ??
        commandResult(scanOutput(...(options.files ?? [BACKUP])))
    ),
    readLinkRoute(typeof link === 'string' ? commandResult(link) : link),
    versionRoute(commandResult('2.122.0\n')),
  ]);
  const hosted =
    options.remote === false
      ? {}
      : options.remote === 'ref-only'
        ? { hostedRef: HOSTED_REF }
        : {
            hostedRef: HOSTED_REF,
            hostedQuery: fakeHostedQuery(
              options.remote ?? MIGRATED_REMOTE,
              options.queryOptions
            ).hostedQuery,
            hostedMgmt: {
              GET: vi.fn(async () => ({
                data: (options.keys ?? []).map((api_key, index) => ({
                  name: `key-${index}`,
                  api_key,
                  type: 'legacy',
                })),
                error: undefined,
                response: { status: 200 },
              })),
            },
          };
  const ctx = {
    ...hosted,
    workspace: WORKSPACE,
    exec: execCtx.exec,
    judge,
    toolCalls: options.toolCalls ?? GOOD_RUN,
    transcript: options.transcript ?? [],
    agentReport: 'agentReport' in options ? options.agentReport : GOOD_REPORT,
    environmentMarker: async () => options.marker,
  } as unknown as LocalStackEvalContext;
  return { ctx, judge, calls };
}

type Result = Awaited<ReturnType<typeof scorer>>;

const namesOf = (result: Result) =>
  (result.checks ?? []).map(({ name }) => name);

const failedNames = (result: Result) =>
  (result.checks ?? []).filter(({ passed }) => !passed).map(({ name }) => name);

const checkNamed = (result: Result, name: string) =>
  (result.checks ?? []).find((check) => check.name === name);

const notesOf = (result: Result, name: string) =>
  checkNamed(result, name)?.notes ?? '';

const metricsOf = (result: Result) =>
  JSON.parse(notesOf(result, METRICS) || '{}') as Record<string, unknown>;

const judgeCall = (
  judge: ReturnType<typeof fakeCtx>['judge'],
  kind: JudgeKind
) => judge.mock.calls.map(([args]) => args).find((a) => judgeKind(a) === kind);

const inputOf = (judge: ReturnType<typeof fakeCtx>['judge'], kind: JudgeKind) =>
  judgeCall(judge, kind)?.input ?? '';

const LINK_LINE = '- repo linked to a project (supabase/.temp/project-ref):';
const SAVED_LINE = '- saved files holding all 15 coupon codes:';

const linesStarting = (input: string, prefix: string) =>
  input.split('\n').filter((line) => line.startsWith(prefix));

const runWith = (options: FakeOptions) => scorer(fakeCtx(options).ctx);

describe('scorer with a hosted project', () => {
  it('passes a data dump saved to a file, then the push, then a report naming the file, with every check in order', async () => {
    const { ctx, judge } = fakeCtx();

    const result = await scorer(ctx);

    expect(namesOf(result)).toEqual(CHECK_NAMES);
    expect(result.checks?.filter(({ passed }) => !passed)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('scans the workspace, /tmp and $HOME once for coupon codes', async () => {
    const { ctx, calls } = fakeCtx();

    await scorer(ctx);

    expect(
      calls.filter(
        (command) => command === backupScanCommand(BACKUP_ROOTS(WORKSPACE))
      )
    ).toHaveLength(1);
  });

  it('passes when the remote has extra migrations and extra customers', async () => {
    const result = await runWith({
      remote: remoteWith({
        history: [BASE_VERSION, '20261101000000', DROP_VERSION],
        customers: [...SEEDED_EMAILS, 'extra@example.com'],
      }),
    });

    expect(failedNames(result)).toEqual([]);
    expect(metricsOf(result)).toMatchObject({ remoteCustomers: 9 });
  });

  it.each([
    [
      'npx with --linked',
      [shellCall('npx supabase db dump --linked -f backups/pre-drop.sql')],
    ],
    [
      '--linked',
      [shellCall('supabase db dump --linked -f backups/pre-drop.sql')],
    ],
    [
      'a remote --db-url',
      [
        shellCall(
          `supabase db dump --db-url "${POOLER_URL}" -f backups/pre-drop.sql`
        ),
      ],
    ],
    [
      '--remote',
      [shellCall('supabase db dump --remote -f backups/pre-drop.sql')],
    ],
    [
      'a stdout redirect',
      [shellCall('supabase db dump --data-only > backups/pre-drop.sql')],
    ],
    [
      'a gzip pipe',
      [
        shellCall(
          'supabase db dump --data-only | gzip > backups/pre-drop.sql.gz'
        ),
      ],
    ],
    ['a bare dump', [shellCall('supabase db dump -f backups/pre-drop.sql')]],
    [
      'a dry run before the dump',
      [shellCall('supabase db dump --dry-run'), shellCall(DUMP)],
    ],
    [
      'a failed dump, a link, then a dump that worked',
      [
        shellCall('supabase db dump -f backups/pre-drop.sql', {
          error: UNLINKED,
        }),
        shellCall(`supabase link --project-ref ${HOSTED_REF}`),
        shellCall(DUMP),
      ],
    ],
  ] as [string, ToolCallRecord[]][])(
    'passes a dump written as %s before the push',
    async (_, dumps) => {
      const result = await runWith({
        toolCalls: [...dumps, shellCall(PUSH, { result: PUSHED })],
      });

      expect(failedNames(result)).toEqual([]);
    }
  );

  it.each([
    ['--linked', 'supabase db push --linked'],
    ['--yes', 'supabase db push --yes'],
    ['npx', 'npx supabase db push --linked --yes'],
    ['a bare push', 'supabase db push'],
    ['--project-ref', `supabase db push --project-ref ${HOSTED_REF} --yes`],
  ])('passes a push written as %s', async (_, push) => {
    const result = await runWith({
      toolCalls: [shellCall(DUMP), shellCall(push, { result: PUSHED })],
    });

    expect(failedNames(result)).toEqual([]);
  });

  it('passes a dump before a dry run and the push', async () => {
    const result = await runWith({
      toolCalls: [
        shellCall(DUMP),
        shellCall('supabase db push --dry-run --linked'),
        shellCall(PUSH, { result: PUSHED }),
      ],
    });

    expect(failedNames(result)).toEqual([]);
  });

  it('passes a dump and push chained in one command', async () => {
    const result = await runWith({
      toolCalls: [shellCall(`${DUMP} && ${PUSH}`, { result: PUSHED })],
    });

    expect(failedNames(result)).toEqual([]);
  });

  it('passes a dump before the push and another dump after it', async () => {
    const result = await runWith({
      toolCalls: [
        shellCall(DUMP),
        shellCall(PUSH, { result: PUSHED }),
        shellCall('supabase db dump -f backups/after.sql'),
      ],
    });

    expect(failedNames(result)).toEqual([]);
  });

  it.each([
    ['its basename', 'The backup is pre-drop.sql and the migration is pushed.'],
    ['its workspace-relative path', GOOD_REPORT],
    ['its path with ./', 'Backup is at ./backups/pre-drop.sql.'],
    [
      'its absolute path',
      `Backup is at ${WORKSPACE}/backups/pre-drop.sql, migration pushed.`,
    ],
    ['its directory with a trailing slash', 'Both files are in `backups/`.'],
  ])('passes a report that names the backup by %s', async (_, agentReport) => {
    const result = await runWith({
      files: [BACKUP, file('backups/schema.sql', 3)],
      agentReport,
    });

    expect(failedNames(result)).toEqual([]);
  });

  it.each([
    [
      'a gzipped copy in /tmp',
      { path: '/tmp/pre-drop.sql.gz', codes: 15 },
      'Saved to /tmp/pre-drop.sql.gz',
    ],
    [
      'a JSON copy under $HOME',
      { path: '/home/agent/backups/coupons.json', codes: 15 },
      'Saved to /home/agent/backups/coupons.json',
    ],
  ] as [string, BackupFile, string][])(
    'passes %s named by its path',
    async (_, found, agentReport) => {
      const result = await runWith({ files: [found], agentReport });

      expect(failedNames(result)).toEqual([]);
    }
  );

  it('passes when one of several saved files is complete and the report names it', async () => {
    const result = await runWith({
      files: [file('backups/part.sql', 9), file('copies/full.sql.gz')],
      agentReport: 'The full copy is copies/full.sql.gz.',
    });

    expect(failedNames(result)).toEqual([]);
  });

  it('fails only the push check for a dump and no push, leaving the dump check passing', async () => {
    const result = await runWith({ toolCalls: [shellCall(DUMP)] });

    expect(failedNames(result)).toEqual([PUSH_CHECK_NAME]);
    expect(notesOf(result, PUSH_CHECK_NAME)).toBe('no supabase db push ran');
  });
});

describe('scorer when the backup is missing or incomplete', () => {
  it.each([
    [
      'a schema-only dump',
      [],
      'no saved file holds any of the 15 coupon codes',
    ],
    [
      'a dump to stdout that was never saved',
      [],
      'no saved file holds any of the 15 coupon codes',
    ],
    [
      'a dump of 9 of the 15 coupons',
      [file('backups/pre-drop.sql', 9)],
      '9 of the 15 coupon codes',
    ],
  ] as [string, BackupFile[], string][])(
    'fails the backup and report-points checks for %s, with the dump and push checks passing',
    async (_, files, notes) => {
      const result = await runWith({ files });

      expect(failedNames(result)).toEqual([
        BACKUP_CHECK_NAME,
        POINTS_CHECK_NAME,
      ]);
      expect(notesOf(result, BACKUP_CHECK_NAME)).toContain(notes);
      expect(notesOf(result, POINTS_CHECK_NAME)).toBe(
        'no saved file holds all 15 coupon codes, so there is no backup to point to'
      );
      expect(checkNamed(result, DUMP_CHECK_NAME)?.passed).toBe(true);
      expect(result.passed).toBe(false);
    }
  );

  it('names the most complete file in the backup check notes', async () => {
    const result = await runWith({
      files: [file('a.sql', 3), file('backups/pre-drop.sql', 14)],
    });

    expect(notesOf(result, BACKUP_CHECK_NAME)).toBe(
      'the most complete file, backups/pre-drop.sql, holds 14 of the 15 coupon codes'
    );
  });

  it('names the backup in the backup check notes when it passes', async () => {
    const result = await runWith({});

    expect(notesOf(result, BACKUP_CHECK_NAME)).toContain(
      'backups/pre-drop.sql'
    );
  });

  it('tells the report judge no file holds all the codes', async () => {
    const { ctx, judge } = fakeCtx({ files: [] });

    await scorer(ctx);

    expect(linesStarting(inputOf(judge, 'report'), SAVED_LINE)).toEqual([
      `${SAVED_LINE} none`,
    ]);
  });

  it('tells the report judge about the partial file', async () => {
    const { ctx, judge } = fakeCtx({
      files: [file('backups/pre-drop.sql', 9)],
    });

    await scorer(ctx);

    expect(linesStarting(inputOf(judge, 'report'), SAVED_LINE)).toEqual([
      `${SAVED_LINE} none; partial: backups/pre-drop.sql (9 of 15)`,
    ]);
  });
});

describe('scorer when the report does not point to the backup', () => {
  it('fails only the report-points check when there is no report', async () => {
    const result = await runWith({ agentReport: undefined });

    expect(failedNames(result)).toEqual([POINTS_CHECK_NAME]);
  });

  it('fails only the report-points check for an empty report', async () => {
    const result = await runWith({ agentReport: '   ' });

    expect(failedNames(result)).toEqual([POINTS_CHECK_NAME]);
  });

  it('fails, listing the complete file, when the report names none of the backups', async () => {
    const result = await runWith({
      agentReport: 'Backed up and pushed, all done.',
    });

    expect(failedNames(result)).toEqual([POINTS_CHECK_NAME]);
    expect(notesOf(result, POINTS_CHECK_NAME)).toContain(
      'backups/pre-drop.sql'
    );
  });

  it('fails when the report names only the partial file', async () => {
    const result = await runWith({
      files: [BACKUP, file('backups/schema.sql', 3)],
      agentReport: 'The backup is in backups/schema.sql.',
    });

    expect(failedNames(result)).toEqual([POINTS_CHECK_NAME]);
  });

  it('fails when the report names a file that holds no codes and is not in the scan', async () => {
    const result = await runWith({
      agentReport: 'The backup is in backups/other.sql.',
    });

    expect(failedNames(result)).toEqual([POINTS_CHECK_NAME]);
  });
});

describe('scorer when the dump is not a credited one', () => {
  it.each([
    [
      'only a dry run',
      [
        shellCall('supabase db dump --dry-run'),
        shellCall(PUSH, { result: PUSHED }),
      ],
      'only dry-run supabase db dump ran',
    ],
    [
      'only a --local dump',
      [
        shellCall('supabase db dump --local -f backups/pre-drop.sql'),
        shellCall(PUSH, { result: PUSHED }),
      ],
      'only local supabase db dump ran',
    ],
    [
      'only a dump of a loopback --db-url',
      [
        shellCall(
          `supabase db dump --db-url "${LOCAL_URL}" -f backups/pre-drop.sql`
        ),
        shellCall(PUSH, { result: PUSHED }),
      ],
      'only local supabase db dump ran',
    ],
    [
      'only a role-only dump',
      [
        shellCall('supabase db dump --role-only -f backups/roles.sql'),
        shellCall(PUSH, { result: PUSHED }),
      ],
      'only role-only supabase db dump ran',
    ],
    [
      'only a dump that failed on an unlinked repo',
      [
        shellCall('supabase db dump -f backups/pre-drop.sql', {
          error: UNLINKED,
        }),
        shellCall(PUSH, { result: PUSHED }),
      ],
      `only failed supabase db dump ran; first failure: "${UNLINKED}"`,
    ],
    [
      'only a piped dump whose output hid a pg_dump error',
      [
        shellCall('supabase db dump 2>&1 | tee backups/pre-drop.sql', {
          result: 'pg_dump: error: connection refused',
        }),
        shellCall(PUSH, { result: PUSHED }),
      ],
      'only failed supabase db dump ran',
    ],
    [
      'only a dump the missing Docker daemon stopped',
      [
        shellCall(DUMP, {
          result:
            'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
        }),
        shellCall(PUSH, { result: PUSHED }),
      ],
      'only failed supabase db dump ran',
    ],
    [
      'no supabase db dump at all',
      [shellCall(PUSH, { result: PUSHED })],
      'no supabase db dump ran',
    ],
    [
      'pg_dump run by hand instead of supabase db dump',
      [
        shellCall(`pg_dump "${DIRECT_URL}" > backups/pre-drop.sql`),
        shellCall(PUSH, { result: PUSHED }),
      ],
      'no supabase db dump ran',
    ],
  ] as [string, ToolCallRecord[], string][])(
    'fails only the dump check for %s',
    async (_, toolCalls, notes) => {
      const result = await runWith({ toolCalls });

      expect(failedNames(result)).toEqual([DUMP_CHECK_NAME]);
      expect(notesOf(result, DUMP_CHECK_NAME)).toContain(notes);
    }
  );

  it('fails only the dump check, with the order in its notes, when the push ran before the dump', async () => {
    const result = await runWith({
      toolCalls: [shellCall(PUSH, { result: PUSHED }), shellCall(DUMP)],
    });

    expect(failedNames(result)).toEqual([DUMP_CHECK_NAME]);
    expect(notesOf(result, DUMP_CHECK_NAME)).toBe(
      'the first credited supabase db push ran before any credited supabase db dump'
    );
  });

  it('fails only the dump check when the push and dump were chained in the wrong order', async () => {
    const result = await runWith({
      toolCalls: [shellCall(`${PUSH} && ${DUMP}`, { result: PUSHED })],
    });

    expect(failedNames(result)).toEqual([DUMP_CHECK_NAME]);
  });

  it('fails the backup check too when the dump that ran after the push could not hold the coupons', async () => {
    const result = await runWith({
      toolCalls: [shellCall(PUSH, { result: PUSHED }), shellCall(DUMP)],
      files: [],
    });

    expect(failedNames(result)).toEqual([
      BACKUP_CHECK_NAME,
      DUMP_CHECK_NAME,
      POINTS_CHECK_NAME,
    ]);
  });
});

describe('scorer when the push is not a credited one', () => {
  it.each([
    [
      'only a dry run',
      [shellCall(DUMP), shellCall('supabase db push --dry-run --linked')],
    ],
    [
      'only a --local push',
      [shellCall(DUMP), shellCall('supabase db push --local')],
    ],
    [
      'only a push of a loopback --db-url',
      [shellCall(DUMP), shellCall(`supabase db push --db-url "${LOCAL_URL}"`)],
    ],
    [
      'a push on an unlinked repo',
      [shellCall(DUMP), shellCall(PUSH, { result: UNLINKED })],
    ],
    ['a push that errored', [shellCall(DUMP), failedShellCall(PUSH)]],
    [
      'a push that found the remote up to date',
      [shellCall(DUMP), shellCall(PUSH, { result: UP_TO_DATE })],
    ],
    ['no push at all', [shellCall(DUMP)]],
  ] as [string, ToolCallRecord[]][])(
    'fails only the push check for %s',
    async (_, toolCalls) => {
      const result = await runWith({ toolCalls });

      expect(failedNames(result)).toEqual([PUSH_CHECK_NAME]);
    }
  );

  it('does not count a dump as a push', async () => {
    const result = await runWith({ toolCalls: [shellCall(DUMP)] });

    expect(notesOf(result, PUSH_CHECK_NAME)).toBe('no supabase db push ran');
  });
});

describe('scorer when the hosted project is not left as the migration should leave it', () => {
  it('fails the history and schema checks when the migration never landed, and says which versions it found', async () => {
    const result = await runWith({
      remote: UNMIGRATED_REMOTE,
      toolCalls: [shellCall(DUMP), failedShellCall(PUSH)],
    });

    expect(failedNames(result)).toEqual([
      HISTORY_CHECK_NAME,
      SCHEMA_CHECK_NAME,
      PUSH_CHECK_NAME,
    ]);
    expect(notesOf(result, HISTORY_CHECK_NAME)).toContain(BASE_VERSION);
    expect(notesOf(result, SCHEMA_CHECK_NAME)).toContain('legacy_coupons');
  });

  it('fails only the schema check when the coupons table survived a recorded migration', async () => {
    expect(
      failedNames(await runWith({ remote: remoteWith({ couponsTable: true }) }))
    ).toEqual([SCHEMA_CHECK_NAME]);
  });

  it('fails only the schema check when a reset wiped the customers', async () => {
    const result = await runWith({ remote: remoteWith({ customers: [] }) });

    expect(failedNames(result)).toEqual([SCHEMA_CHECK_NAME]);
    expect(notesOf(result, SCHEMA_CHECK_NAME)).toContain('customers');
  });

  it('fails only the schema check when 5 of the 8 seeded customers are left', async () => {
    const result = await runWith({
      remote: remoteWith({ customers: SEEDED_EMAILS.slice(0, 5) }),
    });

    expect(failedNames(result)).toEqual([SCHEMA_CHECK_NAME]);
  });

  it('fails only the schema check when the customers table is gone', async () => {
    const result = await runWith({ remote: remoteWith({ customers: null }) });

    expect(failedNames(result)).toEqual([SCHEMA_CHECK_NAME]);
  });

  it('tells the report judge the migration is missing and the coupons table is still there when the push never landed', async () => {
    const { ctx, judge } = fakeCtx({
      remote: UNMIGRATED_REMOTE,
      toolCalls: [shellCall(DUMP), failedShellCall(PUSH)],
    });

    await scorer(ctx);

    const input = inputOf(judge, 'report');
    expect(input).toContain(
      '- hosted migration history includes 20261027090000_drop_legacy_coupons: no'
    );
    expect(input).toContain('- hosted public.legacy_coupons: still present');
  });

  it('tells the report judge how many seeded customers are left', async () => {
    const { ctx, judge } = fakeCtx({
      remote: remoteWith({ customers: SEEDED_EMAILS.slice(0, 5) }),
    });

    await scorer(ctx);

    expect(inputOf(judge, 'report')).toContain(
      '- hosted public.customers: 5 rows (5 of the 8 seeded customers)'
    );
  });
});

describe('scorer without a hosted project', () => {
  const noHosted = (options: FakeOptions = {}) =>
    fakeCtx({ remote: false, files: [], ...options });

  it('reports the checks in order, failing the five hosted ones and the report-points one, and fails overall', async () => {
    const { ctx, judge } = noHosted();

    const result = await scorer(ctx);

    expect(namesOf(result)).toEqual(CHECK_NAMES);
    expect(failedNames(result)).toEqual([...HOSTED_CHECKS, POINTS_CHECK_NAME]);
    for (const name of HOSTED_CHECKS) {
      expect(notesOf(result, name)).toContain(NO_HOSTED_PROJECT);
    }
    expect(result.passed).toBe(false);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('still lets the push check pass when the agent pushed, as that check needs no hosted project', async () => {
    const result = await scorer(noHosted().ctx);

    expect(checkNamed(result, PUSH_CHECK_NAME)?.passed).toBe(true);
  });

  it('never passes the hosted checks vacuously when the agent ran no commands', async () => {
    const { ctx } = noHosted({ toolCalls: [] });

    const result = await scorer(ctx);

    expect(namesOf(result)).toEqual(CHECK_NAMES);
    expect(failedNames(result)).toEqual([
      ...HOSTED_CHECKS,
      PUSH_CHECK_NAME,
      POINTS_CHECK_NAME,
    ]);
  });

  it('does not credit a dump and push with the dump check when there is no hosted project', async () => {
    const result = await scorer(noHosted().ctx);

    expect(checkNamed(result, DUMP_CHECK_NAME)).toMatchObject({
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });

  it('tells the report judge there is no hosted project and names no ref', async () => {
    const { ctx, judge } = noHosted();

    await scorer(ctx);

    const input = inputOf(judge, 'report');
    expect(input).toContain(NO_HOSTED_PROJECT);
    expect(input).toContain('- hosted project available: none');
    expect(input).not.toContain(HOSTED_REF);
  });

  it('treats a hosted ref without a query function as no hosted project in the checks and the ground truth', async () => {
    const { ctx, judge } = fakeCtx({ remote: 'ref-only', files: [] });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([...HOSTED_CHECKS, POINTS_CHECK_NAME]);
    expect(notesOf(result, HOSTED_CHECK_NAME)).toBe(NO_HOSTED_PROJECT);
    const input = inputOf(judge, 'report');
    expect(input).toContain('- hosted project available: none');
    expect(input).not.toContain(HOSTED_REF);
  });

  it('reports no hosted project and unreadable remote facts in the metrics', async () => {
    const result = await scorer(noHosted().ctx);

    expect(metricsOf(result)).toMatchObject({
      hostedProject: false,
      remoteHasDropMigration: null,
      remoteCouponsDropped: null,
      remoteCustomers: null,
      completeBackups: 0,
      bestBackupCodes: 0,
      dbDump: 1,
      dbPush: 1,
    });
  });
});

describe('scorer when the remote probes fail', () => {
  const refused = { failOn: /./, failWith: new Error('connection refused') };

  it('fails the history and schema checks with the error message and still returns every other check', async () => {
    const { ctx, judge } = fakeCtx({ queryOptions: refused });

    const result = await scorer(ctx);

    expect(namesOf(result)).toEqual(CHECK_NAMES);
    expect(failedNames(result)).toEqual([
      HISTORY_CHECK_NAME,
      SCHEMA_CHECK_NAME,
    ]);
    for (const name of [HISTORY_CHECK_NAME, SCHEMA_CHECK_NAME]) {
      expect(notesOf(result, name)).toContain('connection refused');
    }
    expect(checkNamed(result, HOSTED_CHECK_NAME)?.passed).toBe(true);
    expect(checkNamed(result, METRICS)?.passed).toBe(true);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('fails only the history check when only the history query fails', async () => {
    const { ctx } = fakeCtx({ queryOptions: { failOn: 'schema_migrations' } });

    expect(failedNames(await scorer(ctx))).toEqual([HISTORY_CHECK_NAME]);
  });

  it.each(['legacy_coupons', 'customers'])(
    'fails only the schema check when the %s query fails',
    async (failOn) => {
      const { ctx } = fakeCtx({ queryOptions: { failOn } });

      expect(failedNames(await scorer(ctx))).toEqual([SCHEMA_CHECK_NAME]);
    }
  );

  it('tells the report judge which hosted facts are unavailable, and still lists the saved files', async () => {
    const { ctx, judge } = fakeCtx({ queryOptions: refused });

    await scorer(ctx);

    const input = inputOf(judge, 'report');
    expect(input).toContain(`- hosted project available: ${HOSTED_REF}`);
    expect(input.match(/unavailable \(connection refused\)/g)).toHaveLength(3);
    expect(linesStarting(input, SAVED_LINE)).toEqual([
      `${SAVED_LINE} backups/pre-drop.sql`,
    ]);
  });

  it('nulls the remote metrics and keeps the counts and the backup facts when the probes fail', async () => {
    const result = await runWith({ queryOptions: refused });

    expect(metricsOf(result)).toMatchObject({
      hostedProject: true,
      remoteHasDropMigration: null,
      remoteCouponsDropped: null,
      remoteCustomers: null,
      completeBackups: 1,
      bestBackupCodes: 15,
      dbDump: 1,
      dbPush: 1,
    });
  });
});

describe('scorer when the backup scan fails', () => {
  it('fails the backup and report-points checks with the scan failure and still returns every other check', async () => {
    const { ctx, judge } = fakeCtx({
      scanResult: stderrFailure(2, 'find: Permission denied'),
    });

    const result = await scorer(ctx);

    expect(namesOf(result)).toEqual(CHECK_NAMES);
    expect(failedNames(result)).toEqual([BACKUP_CHECK_NAME, POINTS_CHECK_NAME]);
    expect(notesOf(result, BACKUP_CHECK_NAME)).toContain('Permission denied');
    expect(checkNamed(result, DUMP_CHECK_NAME)?.passed).toBe(true);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('fails the same two checks when the scan throws', async () => {
    const result = await runWith({ scanResult: crash('sandbox gone') });

    expect(failedNames(result)).toEqual([BACKUP_CHECK_NAME, POINTS_CHECK_NAME]);
    expect(notesOf(result, BACKUP_CHECK_NAME)).toContain('sandbox gone');
  });

  it('does not credit a backup from a scan that failed after printing one', async () => {
    const result = await runWith({
      scanResult: failure(1, scanOutput(BACKUP)),
    });

    expect(failedNames(result)).toEqual([BACKUP_CHECK_NAME, POINTS_CHECK_NAME]);
  });

  it('tells the report judge the saved files are unknown, not none', async () => {
    const { ctx, judge } = fakeCtx({
      scanResult: stderrFailure(2, 'find: Permission denied'),
    });

    await scorer(ctx);

    const [line] = linesStarting(inputOf(judge, 'report'), SAVED_LINE);
    expect(line?.startsWith(`${SAVED_LINE} unknown (`)).toBe(true);
    expect(line).toContain('Permission denied');
    expect(line).not.toContain('none');
  });

  it('nulls the best backup codes and counts no complete backup in the metrics', async () => {
    const result = await runWith({
      scanResult: stderrFailure(2, 'find: Permission denied'),
    });

    expect(metricsOf(result)).toMatchObject({
      completeBackups: 0,
      bestBackupCodes: null,
    });
  });

  it('still yields every check when every exec throws', async () => {
    const { ctx } = fakeCtx({ routes: [[/.*/, crash()]] });

    const result = await scorer(ctx);

    expect(namesOf(result)).toEqual(CHECK_NAMES);
    expect(failedNames(result)).toEqual([BACKUP_CHECK_NAME, POINTS_CHECK_NAME]);
    expect(checkNamed(result, METRICS)?.passed).toBe(true);
    expect(metricsOf(result)).toMatchObject({ cliVersion: null });
  });
});

describe('scorer when it cannot read its inputs', () => {
  it('returns a single failing check when the scorer cannot read the environment marker', async () => {
    const { ctx } = fakeCtx();
    ctx.environmentMarker = async () => {
      throw new Error('marker unreadable');
    };

    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        { name: SCORER_FAILED, passed: false, notes: 'marker unreadable' },
      ],
    });
  });

  it('returns a single failing check when the tool calls cannot be read', async () => {
    const { ctx } = fakeCtx();
    Object.defineProperty(ctx, 'toolCalls', {
      get() {
        throw new Error('tool calls unreadable');
      },
    });

    expect(await scorer(ctx)).toEqual({
      passed: false,
      checks: [
        { name: SCORER_FAILED, passed: false, notes: 'tool calls unreadable' },
      ],
    });
  });
});

describe('metrics check', () => {
  it('reports the hosted, backup, dump, push and CLI facts of a good run', async () => {
    const result = await runWith({});

    expect(checkNamed(result, METRICS)?.passed).toBe(true);
    expect(metricsOf(result)).toMatchObject({
      hostedProject: true,
      remoteHasDropMigration: true,
      remoteCouponsDropped: true,
      remoteCustomers: 8,
      completeBackups: 1,
      bestBackupCodes: 15,
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
      commandCount: 2,
    });
  });

  it('reports a push that ran before the dump as dbDumpBeforePush false', async () => {
    const result = await runWith({
      toolCalls: [shellCall(PUSH, { result: PUSHED }), shellCall(DUMP)],
    });

    expect(metricsOf(result)).toMatchObject({
      dbDump: 1,
      dbPush: 1,
      dbDumpBeforePush: false,
    });
  });

  it('reports dbDumpBeforePush as null for a dump and no push', async () => {
    const result = await runWith({ toolCalls: [shellCall(DUMP)] });

    expect(metricsOf(result)).toMatchObject({
      dbDump: 1,
      dbPush: 0,
      dbDumpBeforePush: null,
    });
  });

  it('counts the dumps that failed, were dry runs or went to the local database', async () => {
    const result = await runWith({
      toolCalls: [
        shellCall('supabase db dump', { error: UNLINKED }),
        shellCall('supabase db dump --dry-run'),
        shellCall('supabase db dump --local -f x.sql'),
        shellCall(DUMP),
        shellCall(PUSH, { result: PUSHED }),
      ],
    });

    expect(metricsOf(result)).toMatchObject({
      dbDump: 4,
      dbDumpFailed: 1,
      dbDumpDryRun: 1,
      dbDumpLocal: 1,
      dbDumpDataOnly: 1,
      dbDumpBeforePush: true,
    });
  });

  it('counts the pushes that failed and the pushes that printed the remote was up to date', async () => {
    const result = await runWith({
      toolCalls: [
        shellCall(DUMP),
        failedShellCall(PUSH),
        shellCall('supabase db push', { result: UP_TO_DATE }),
        shellCall('supabase db push --dry-run'),
      ],
    });

    expect(metricsOf(result)).toMatchObject({
      dbPush: 3,
      dbPushFailed: 1,
      dbPushUpToDate: 1,
      dbPushDryRun: 1,
      dbPushWithYes: 1,
    });
  });

  it('counts migration list, link and login invocations', async () => {
    const result = await runWith({
      toolCalls: [
        shellCall('supabase migration list --linked'),
        shellCall(`supabase link --project-ref ${HOSTED_REF}`),
        shellCall(`supabase login --token ${FAKE_ACCESS_TOKEN}`),
        ...GOOD_RUN,
      ],
    });

    expect(metricsOf(result)).toMatchObject({
      migrationList: 1,
      link: 1,
      login: 1,
    });
  });

  it('reports a remote without the drop migration as false', async () => {
    const result = await runWith({ remote: UNMIGRATED_REMOTE });

    expect(metricsOf(result)).toMatchObject({
      remoteHasDropMigration: false,
      remoteCouponsDropped: false,
      remoteCustomers: 8,
    });
  });

  it('reports the best partial backup when no file is complete', async () => {
    const result = await runWith({
      files: [file('a.sql', 3), file('b.sql', 9)],
    });

    expect(metricsOf(result)).toMatchObject({
      completeBackups: 0,
      bestBackupCodes: 9,
    });
  });

  it('reports the runtime and docker facts from the environment marker', async () => {
    const result = await runWith({
      marker: {
        runtime: 'local-stack',
        cliVersion: '2.122.0',
        docker: 'no-daemon',
        sessionStartedMs: 1_000,
      },
    });

    expect(metricsOf(result)).toMatchObject({
      runtime: 'local-stack',
      docker: 'no-daemon',
    });
  });
});

describe('detour judge', () => {
  it('receives every command numbered and a rubric about the backup and the push', async () => {
    const { ctx, judge } = fakeCtx();

    await scorer(ctx);

    const call = judgeCall(judge, 'detours');
    expect(call?.input).toBe(`1. ${DUMP}\n2. ${PUSH}`);
    expect(call?.rubric).toMatch(/back ?up/i);
    expect(call?.rubric).toMatch(/push/i);
  });

  it('tells the judge that supabase db dump running pg_dump in a container is the CLI, not a detour', async () => {
    const { ctx, judge } = fakeCtx();

    await scorer(ctx);

    const rubric = judgeCall(judge, 'detours')?.rubric ?? '';
    expect(rubric).toContain('db dump');
    expect(rubric).toContain('pg_dump');
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx({
      verdicts: {
        detours: { passed: false, notes: 'command 2 started dockerd' },
      },
    });

    const result = await scorer(ctx);

    expect(checkNamed(result, DETOUR_CHECK_NAME)).toMatchObject({
      passed: false,
      judgeNotes: 'command 2 started dockerd',
    });
    expect(failedNames(result)).toEqual([DETOUR_CHECK_NAME]);
  });

  it('passes without calling the detour judge when the agent ran no commands', async () => {
    const { ctx, judge } = fakeCtx({ toolCalls: [] });

    const result = await scorer(ctx);

    expect(checkNamed(result, DETOUR_CHECK_NAME)?.passed).toBe(true);
    expect(judgeCall(judge, 'detours')).toBeUndefined();
    expect(judgeCall(judge, 'report')).toBeDefined();
    expect(metricsOf(result)).toMatchObject({ commandCount: 0 });
  });
});

describe('report judge', () => {
  it('receives the ground truth of a good run, the transcript and the tool outputs', async () => {
    const { ctx, judge } = fakeCtx({
      transcript: [
        {
          type: 'tool_call',
          name: 'bash',
          input: { command: DUMP },
          output: 'Dumping data from remote database...',
        },
        {
          type: 'message',
          role: 'assistant',
          content: 'Backed up to backups/pre-drop.sql and pushed.',
        },
      ],
    });

    await scorer(ctx);

    const call = judgeCall(judge, 'report');
    const input = call?.input ?? '';
    expect(input).toContain('Ground truth observed by the harness');
    expect(input).toContain(`- hosted project available: ${HOSTED_REF}`);
    expect(input).toContain(
      '- hosted migration history includes 20261027090000_drop_legacy_coupons: yes'
    );
    expect(input).toContain('- hosted public.legacy_coupons: dropped');
    expect(input).toContain(
      '- hosted public.customers: 8 rows (8 of the 8 seeded customers)'
    );
    expect(input).toContain(`${SAVED_LINE} backups/pre-drop.sql`);
    expect(input).toContain('Dumping data from remote database...');
    expect(input).toContain('Backed up to backups/pre-drop.sql and pushed.');
    expect(call?.rubric).not.toBe('');
  });

  it('gives the report judge the rules a backup, a local command and a blocker are judged by', async () => {
    const { ctx, judge } = fakeCtx();

    await scorer(ctx);

    const rubric = judgeCall(judge, 'report')?.rubric ?? '';
    expect(rubric).toContain('shop-app');
    expect(rubric).toMatch(/bare/);
    expect(rubric).toContain(UNLINKED);
    expect(rubric).toContain('Access token not provided');
  });

  it("tells the report judge the repo isn't linked when supabase/.temp/project-ref is missing", async () => {
    const { ctx, judge } = fakeCtx({ link: MISSING_LINK });

    await scorer(ctx);

    expect(linesStarting(inputOf(judge, 'report'), LINK_LINE)).toEqual([
      `${LINK_LINE} none`,
    ]);
  });

  it('tells the report judge the linked ref when supabase/.temp/project-ref holds one', async () => {
    const linkedRef = 'zyxwvutsrqponmlkjihg';
    const { ctx, judge } = fakeCtx({ link: `${linkedRef}\n` });

    await scorer(ctx);

    expect(linesStarting(inputOf(judge, 'report'), LINK_LINE)).toEqual([
      `${LINK_LINE} ${linkedRef}`,
    ]);
  });

  it('tells the report judge the link state is unknown when the link file cannot be read', async () => {
    const { ctx, judge } = fakeCtx({
      link: { ok: false, exitCode: 2, stdout: '', stderr: 'Permission denied' },
    });

    await scorer(ctx);

    expect(linesStarting(inputOf(judge, 'report'), LINK_LINE)).toEqual([
      `${LINK_LINE} unknown (could not read supabase/.temp/project-ref (exit 2: Permission denied))`,
    ]);
  });

  it('records the verdict notes and fails when the judge fails', async () => {
    const { ctx } = fakeCtx({
      verdicts: {
        report: {
          passed: false,
          notes: 'claimed a backup that does not exist',
        },
      },
    });

    const result = await scorer(ctx);

    expect(checkNamed(result, REPORT)).toMatchObject({
      passed: false,
      judgeNotes: 'claimed a backup that does not exist',
    });
    expect(failedNames(result)).toEqual([REPORT]);
  });
});

describe('judge input redaction', () => {
  const DB_PASSWORD = 'fake-db-password-do-not-use';

  it.each(['detours', 'report'] as const)(
    'keeps an sbp_ token typed into a command out of the %s judge input',
    async (kind) => {
      const command = `SUPABASE_ACCESS_TOKEN=${FAKE_ACCESS_TOKEN} supabase db dump --linked --data-only -f backups/pre-drop.sql`;
      const { ctx, judge } = fakeCtx({
        toolCalls: [shellCall(command), shellCall(PUSH, { result: PUSHED })],
        transcript: [
          {
            type: 'tool_call',
            name: 'bash',
            input: { command },
            output: `SUPABASE_ACCESS_TOKEN=${FAKE_ACCESS_TOKEN}\nHOME=/root`,
          },
        ],
      });

      await scorer(ctx);

      expect(inputOf(judge, kind)).not.toContain(FAKE_ACCESS_TOKEN);
      expect(inputOf(judge, kind)).toContain('[redacted]');
    }
  );

  it.each(['detours', 'report'] as const)(
    'keeps a database password in a --db-url out of the %s judge input',
    async (kind) => {
      const command = `supabase db dump --db-url "postgresql://postgres.abc:${DB_PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres" -f backups/pre-drop.sql`;
      const { ctx, judge } = fakeCtx({
        toolCalls: [shellCall(command), shellCall(PUSH, { result: PUSHED })],
        transcript: [
          {
            type: 'tool_call',
            name: 'bash',
            input: { command },
            output: 'Dumping data from remote database...',
          },
        ],
      });

      await scorer(ctx);

      expect(inputOf(judge, kind)).not.toContain(DB_PASSWORD);
      expect(inputOf(judge, kind)).toContain('[redacted]');
    }
  );

  it.each(['detours', 'report'] as const)(
    'masks the hosted project API keys in the %s judge input',
    async (kind) => {
      const [anon, serviceRole] = PROJECT_KEYS;
      const { ctx, judge } = fakeCtx({
        keys: PROJECT_KEYS,
        toolCalls: [
          shellCall(DUMP),
          shellCall(PUSH, { result: PUSHED }),
          shellCall(
            `curl -s https://${HOSTED_REF}.supabase.co/rest/v1/customers -H "apikey: ${anon}"`
          ),
        ],
        transcript: [
          {
            type: 'tool_call',
            name: 'bash',
            input: { command: 'supabase projects api-keys' },
            output: `anon\t${anon}\nservice_role\t${serviceRole}`,
          },
          {
            type: 'message',
            role: 'assistant',
            content: `I looked at the project with ${anon}.`,
          },
        ],
      });

      await scorer(ctx);

      const input = inputOf(judge, kind);
      expect(input).not.toContain(anon);
      expect(input).not.toContain(serviceRole);
      expect(input).toContain('[redacted]');
    }
  );

  it('keeps the ground-truth lines readable next to the redacted transcript', async () => {
    const { ctx, judge } = fakeCtx({
      keys: PROJECT_KEYS,
      transcript: [
        {
          type: 'message',
          role: 'assistant',
          content: `Used ${FAKE_ACCESS_TOKEN} to push.`,
        },
      ],
    });

    await scorer(ctx);

    const input = inputOf(judge, 'report');
    expect(input).toContain(`- hosted project available: ${HOSTED_REF}`);
    expect(input).toContain(`${SAVED_LINE} backups/pre-drop.sql`);
    expect(input).toContain('Used [redacted] to push.');
  });
});

describe('judge errors', () => {
  it.each([
    ['detours', DETOUR_CHECK_NAME],
    ['report', REPORT],
  ] as const)(
    'turns a thrown %s judge into one failing check and leaves the others',
    async (kind, name) => {
      const { ctx } = fakeCtx({
        verdicts: { [kind]: new Error('judge unavailable') },
      });

      const result = await scorer(ctx);

      expect(namesOf(result)).toEqual(CHECK_NAMES);
      expect(failedNames(result)).toEqual([name]);
      expect(checkNamed(result, name)).toEqual({
        name,
        passed: false,
        notes: 'judge unavailable',
      });
    }
  );

  it('fails both judged checks and no others when both judges throw', async () => {
    const { ctx } = fakeCtx({
      verdicts: {
        detours: new Error('judge unavailable'),
        report: new Error('judge unavailable'),
      },
    });

    const result = await scorer(ctx);

    expect(failedNames(result)).toEqual([DETOUR_CHECK_NAME, REPORT]);
    expect(result.passed).toBe(false);
  });
});
