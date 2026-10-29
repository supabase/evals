// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-007-dump-before-push
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from '../lib/cli-invocations.js';
import type { TargetOptions } from '../lib/db-target.js';
import { extractCommandEntries } from '../lib/detours.js';
import type { BackupScan } from './backup.js';
import {
  type Call,
  activityOf,
  dumpOf,
  failedShellCall,
  file,
  HOSTED_REF,
  pushOf,
  scanOf,
  shellCall,
  WORKSPACE,
} from './fixtures.js';
import {
  checkDumpedBeforePush,
  type DbDump,
  DUMP_CHECK_NAME,
  DUMP_FAILURE_RE,
  isCreditedDump,
  readDbDumps,
} from './dump.js';
import { NO_HOSTED_PROJECT } from './remote.js';

const dumpsOf = (...calls: Call[]) => activityOf(...calls).dumps;

const dumpsWith = (options: TargetOptions, command: string) => {
  const toolCalls = [shellCall(command)];
  return readDbDumps(
    findSupabaseInvocations(extractCommandEntries(toolCalls)),
    toolCalls,
    { workspace: WORKSPACE, ...options }
  );
};

const LOCAL_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const POOLER_URL =
  'postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
const DIRECT_URL = `postgresql://postgres:pw@db.${HOSTED_REF}.supabase.co:5432/postgres`;
const CONTAINER_URL =
  'postgresql://postgres:postgres@supabase_db_shop-app:5432/postgres';
const HARNESS_POOLER_URL =
  'postgresql://postgres:postgres@host.docker.internal:55432/postgres?sslmode=disable';
const LOCAL_STACK_ON_DOCKER_HOST =
  'postgresql://postgres:postgres@host.docker.internal:54322/postgres';
const HOSTED: TargetOptions = {
  remoteEndpoints: ['host.docker.internal:55432'],
};

const DUMP = 'supabase db dump --data-only -f backups/pre-drop.sql';
const PUSH = 'supabase db push --linked --yes';
const CHAINED_DUMP = `${DUMP} && grep -c "^COPY" backups/pre-drop.sql`;
const UNLINKED = 'Cannot find project ref. Have you run supabase link?';
const PG_DUMP_ERROR =
  'pg_dump: error: connection to server at "db.abcdefghijklmnopqrst.supabase.co" failed: Connection refused';
const NO_DOCKER =
  'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
const CONTAINER_ERROR = 'error running container: exit 1';

const FLAG_GROUP_CONFLICT =
  'if any flags in the group [db-url linked local] are set none of the others can be; [db-url linked] were all set';

const CLI_FAILURES: [label: string, output: string][] = [
  ['an unlinked repo', UNLINKED],
  ['a JSON error', '{"_tag":"Error","error":{"code":1,"message":"boom"}}'],
  ['a missing token', 'Access token not provided. Supply an access token.'],
  ['a refused connection', 'failed to connect to postgres'],
  ['an unknown flag', 'unknown flag: --role-only'],
  ['a missing binary', 'zsh: command not found: supabase'],
];

const DUMP_FAILURES: [label: string, output: string][] = [
  ['a pg_dump error', PG_DUMP_ERROR],
  [
    'a pg_dump error in upper case',
    'PG_DUMP: ERROR: server closed the connection',
  ],
  ['a missing Docker daemon', NO_DOCKER],
  ['a failed container', CONTAINER_ERROR],
  ['a failed container in upper case', 'ERROR RUNNING CONTAINER: exit 1'],
];

const CLEAN_OUTPUTS = [
  'Dumping data from remote database...',
  'Dumped schema to backups/pre-drop.sql',
  'pg_dump: warning: there are circular foreign-key constraints on this table',
  '',
];

describe('constants', () => {
  it('keeps the check name stable for the results dashboard', () => {
    expect(DUMP_CHECK_NAME).toBe(
      'the agent dumped the hosted database with supabase db dump before pushing'
    );
  });

  it.each(DUMP_FAILURES)('DUMP_FAILURE_RE matches %s', (_, output) => {
    expect(DUMP_FAILURE_RE.test(output)).toBe(true);
  });

  it.each(CLEAN_OUTPUTS)('DUMP_FAILURE_RE does not match %j', (output) => {
    expect(DUMP_FAILURE_RE.test(output)).toBe(false);
  });
});

describe('readDbDumps', () => {
  it('reads a dump to a file', () => {
    expect(dumpsOf('supabase db dump -f backups/pre-drop.sql')).toEqual([
      dumpOf({ files: [`${WORKSPACE}/backups/pre-drop.sql`] }),
    ]);
  });

  it('reads a bare dump', () => {
    expect(dumpsOf('supabase db dump')).toEqual([dumpOf()]);
  });

  it('numbers an invocation by its place among all supabase invocations', () => {
    expect(
      dumpsOf('supabase migration list --linked', 'supabase db dump -f x.sql')
    ).toEqual([dumpOf({ order: 1, files: [`${WORKSPACE}/x.sql`] })]);
  });

  it('numbers dumps and pushes in one command in the order they run', () => {
    const { dumps, pushes } = activityOf(
      `${DUMP} && ${PUSH} && supabase db dump -f after.sql`
    );
    expect(dumps.map(({ order }) => order)).toEqual([0, 2]);
    expect(pushes.map(({ order }) => order)).toEqual([1]);
  });

  it('reads every dump invocation of one command', () => {
    expect(
      dumpsOf(
        'supabase db dump --role-only -f roles.sql && supabase db dump --data-only -f data.sql'
      ).map(({ order, roleOnly, dataOnly }) => [order, roleOnly, dataOnly])
    ).toEqual([
      [0, true, false],
      [1, false, true],
    ]);
  });

  it.each([
    ['--dry-run', true],
    ['--dry-run=true', true],
    ['--dry-run=false', false],
    ['--linked', false],
  ])('reads %s as dryRun %s', (flag, dryRun) => {
    expect(dumpsOf(`supabase db dump ${flag}`)[0]?.dryRun).toBe(dryRun);
  });

  it.each([
    ['--data-only', true],
    ['--data-only=true', true],
    ['--data-only=false', false],
    ['-f out.sql', false],
  ])('reads %s as dataOnly %s', (flag, dataOnly) => {
    expect(dumpsOf(`supabase db dump ${flag}`)[0]?.dataOnly).toBe(dataOnly);
  });

  it.each([
    ['--role-only', true],
    ['--role-only=true', true],
    ['--role-only=false', false],
    ['--data-only', false],
  ])('reads %s as roleOnly %s', (flag, roleOnly) => {
    expect(dumpsOf(`supabase db dump ${flag}`)[0]?.roleOnly).toBe(roleOnly);
  });

  it.each([
    ['--local', '--local', true],
    ['--db-url on 127.0.0.1', `--db-url "${LOCAL_URL}"`, true],
    ['--db-url= on 127.0.0.1', `--db-url="${LOCAL_URL}"`, true],
    ['--db-url on a container name', `--db-url "${CONTAINER_URL}"`, true],
    ['--remote=<url> on 127.0.0.1', `--remote="${LOCAL_URL}"`, true],
    ['--db-url on a pooler host', `--db-url "${POOLER_URL}"`, false],
    ['--db-url= on a direct host', `--db-url="${DIRECT_URL}"`, false],
    ['--remote=<url> on a direct host', `--remote="${DIRECT_URL}"`, false],
    ['--remote=<ref>', `--remote=${HOSTED_REF}`, false],
    ['--remote', '--remote', false],
    ['--linked', '--linked', false],
    ['--project-ref', `--project-ref ${HOSTED_REF}`, false],
    ['no target flag', '', false],
    [
      'a $VAR --db-url with no assignment',
      '--db-url "$SUPABASE_DB_URL"',
      false,
    ],
  ])('reads %s as explicitlyLocal %s', (_, flags, explicitlyLocal) => {
    expect(
      dumpsOf(`supabase db dump ${flags} -f out.sql`)[0]?.explicitlyLocal
    ).toBe(explicitlyLocal);
  });

  describe('with known hosted endpoints', () => {
    const command = `supabase db dump --db-url "${HARNESS_POOLER_URL}" -f out.sql`;

    it('reads a dump at the hosted endpoint as explicitlyLocal until it is passed', () => {
      expect(dumpsWith({}, command)[0]?.explicitlyLocal).toBe(true);
      expect(dumpsWith(HOSTED, command)[0]?.explicitlyLocal).toBe(false);
    });

    it('credits that dump only when the endpoint is passed', () => {
      const dump = (options: TargetOptions) =>
        dumpsWith(options, `${command} --data-only`)[0] as DbDump;
      expect(isCreditedDump(dump({}), scanOf())).toBe(false);
      expect(isCreditedDump(dump(HOSTED), scanOf())).toBe(true);
    });

    it('reads a variable assigned the hosted URL as remote', () => {
      expect(
        dumpsWith(
          HOSTED,
          `DB_URL="${HARNESS_POOLER_URL}"; supabase db dump --db-url "$DB_URL" -f out.sql`
        )[0]?.explicitlyLocal
      ).toBe(false);
    });

    it('keeps a dump at a local stack on the same host local', () => {
      expect(
        dumpsWith(
          HOSTED,
          `supabase db dump --db-url "${LOCAL_STACK_ON_DOCKER_HOST}" -f out.sql`
        )[0]?.explicitlyLocal
      ).toBe(true);
    });
  });

  it('reads a --db-url variable loaded from supabase status as local', () => {
    expect(
      dumpsOf(
        'eval "$(supabase status -o env)" && supabase db dump --db-url "$DB_URL" -f out.sql'
      )[0]?.explicitlyLocal
    ).toBe(true);
  });

  it.each([
    ['a package runner', 'npx supabase db dump --linked -f x.sql'],
    ['a package runner pin', 'npx -y supabase@2.122.0 db dump --data-only'],
    ['an output redirect', 'supabase db dump --data-only > backups/x.sql'],
    ['a gzip pipe', 'supabase db dump --data-only | gzip > backups/x.sql.gz'],
    ['an env assignment', 'SUPABASE_DB_PASSWORD=pw supabase db dump -f x.sql'],
    ['a directory change', 'cd app && supabase db dump -f x.sql'],
    ['an env wrapper', 'env FOO=1 supabase db dump -f x.sql'],
    ['a subshell', '(supabase db dump -f x.sql)'],
    ['a stderr redirect', 'supabase db dump -f x.sql 2>&1 | tail -5'],
  ])('reads a dump through %s', (_, command) => {
    expect(dumpsOf(command)).toHaveLength(1);
  });

  it.each([
    ['a help request', 'supabase db dump --help'],
    ['an echoed command line', 'echo "supabase db dump -f x.sql"'],
    ['a commented command line', '# supabase db dump'],
    ['db push', 'supabase db push --linked'],
    ['db pull', 'supabase db pull'],
    ['db diff', 'supabase db diff --linked'],
    ['db query', 'supabase db query --linked "select 1"'],
    ['db reset', 'supabase db reset --linked'],
    ['pg_dump', `pg_dump "${DIRECT_URL}" > backups/x.sql`],
    ['psql', `psql "${DIRECT_URL}" -c "copy public.legacy_coupons to stdout"`],
  ])('does not read %s as a dump', (_, command) => {
    expect(dumpsOf(command)).toEqual([]);
  });

  describe('failure', () => {
    it('marks a dump failed when its tool call reported an error', () => {
      const dumps = dumpsOf(failedShellCall(DUMP), shellCall(DUMP));
      expect(dumps.map(({ failed }) => failed)).toEqual([true, false]);
    });

    it.each([...CLI_FAILURES, ...DUMP_FAILURES])(
      'marks a piped dump failed when its output shows %s, with no tool error',
      (_, result) => {
        const dumps = dumpsOf(
          shellCall('supabase db dump --data-only 2>&1 | head -50', { result })
        );
        expect(dumps[0]?.failed).toBe(true);
      }
    );

    it('marks a piped --linked dump failed when its output shows the wrapper flag-group conflict', () => {
      const command = 'supabase db dump --linked --data-only | gzip > b.sql.gz';
      const { dumps, pushes } = activityOf(
        shellCall(command, { result: FLAG_GROUP_CONFLICT })
      );

      expect(dumps).toEqual([
        dumpOf({
          dataOnly: true,
          failed: true,
          failure: FLAG_GROUP_CONFLICT,
          files: [`${WORKSPACE}/b.sql.gz`],
        }),
      ]);
      expect(dumps.some((dump) => isCreditedDump(dump, scanOf()))).toBe(false);
      expect(
        checkDumpedBeforePush(true, dumps, pushes, scanOf())
      ).toMatchObject({
        passed: false,
        notes: `only failed supabase db dump ran; first failure: "${FLAG_GROUP_CONFLICT}"`,
      });
    });

    it.each(DUMP_FAILURES)(
      'marks a dump failed when its output shows %s and nothing else',
      (_, result) => {
        expect(dumpsOf(shellCall(DUMP, { result }))[0]).toMatchObject({
          failed: true,
        });
      }
    );

    it.each(CLEAN_OUTPUTS)(
      'does not mark a dump failed on the output %j',
      (result) => {
        const [first] = dumpsOf(shellCall(DUMP, { result }));
        expect(first?.failed).toBe(false);
        expect(first).not.toHaveProperty('failure');
      }
    );

    it('keeps the first line of the output that shows the failure', () => {
      expect(
        dumpsOf(
          shellCall('supabase db dump 2>&1 | head -50', {
            result: `Dumping data from remote database...\n${UNLINKED}\nTry --help`,
          })
        )[0]
      ).toMatchObject({ failed: true, failure: UNLINKED });
    });

    it('keeps a pg_dump error line as the failure', () => {
      expect(
        dumpsOf(
          shellCall('supabase db dump 2>&1 | head -50', {
            result: `Dumping data from remote database...\n${PG_DUMP_ERROR}\nexit status 1`,
          })
        )[0]
      ).toMatchObject({ failed: true, failure: PG_DUMP_ERROR });
    });

    it('keeps the first line of the error text when the output shows no failure', () => {
      expect(
        dumpsOf(shellCall(DUMP, { error: '\n  exit status 1\nsecond line' }))[0]
      ).toMatchObject({ failed: true, failure: 'exit status 1' });
    });

    it('finds the Docker failure line in the error text of a call with no output', () => {
      const failing = shellCall(DUMP, {
        error: `Warning: --linked is deprecated\n${NO_DOCKER}`,
      });
      expect(failing.result).toBeUndefined();
      expect(dumpsOf(failing)[0]).toMatchObject({
        failed: true,
        failure: NO_DOCKER,
      });
    });

    it('trims the failure line to 200 characters', () => {
      expect(
        dumpsOf(
          shellCall(DUMP, { error: `pg_dump: error: ${'x'.repeat(500)}` })
        )[0]?.failure
      ).toHaveLength(200);
    });

    describe('when a later command in the same tool call fails', () => {
      const WRITTEN =
        'Dumped schema to /tmp/eval-workspace/backups/pre-drop.sql.';
      const CHAINED = `${DUMP} && grep -c "^COPY" backups/pre-drop.sql`;

      it('does not mark a dump failed when its call printed where it wrote, though the call errored on a later grep', () => {
        const [first] = dumpsOf(
          shellCall(CHAINED, { result: WRITTEN, error: 'exit 1' })
        );
        expect(first).toEqual(
          dumpOf({
            dataOnly: true,
            files: [`${WORKSPACE}/backups/pre-drop.sql`],
          })
        );
        expect(first).not.toHaveProperty('failure');
        expect(isCreditedDump(first as DbDump, scanOf())).toBe(true);
      });

      it('does not mark a dump failed when the whole output is in the error text', () => {
        const [first] = dumpsOf(
          shellCall(CHAINED, { error: `${WRITTEN}\nexit status 1` })
        );
        expect(first).toMatchObject({ dataOnly: true, failed: false });
        expect(first).not.toHaveProperty('failure');
      });

      it.each([
        ['plain text', WRITTEN],
        [
          'a bold path',
          'Dumped schema to \x1b[1m/tmp/eval-workspace/backups/pre-drop.sql\x1b[22m.',
        ],
        ['a relative path', 'Dumped schema to backups/pre-drop.sql.'],
      ])('reads the success text with %s', (_, written) => {
        const [first] = dumpsOf(
          shellCall(CHAINED, {
            result: `Dumping data from remote database...\n${written}`,
            error: 'exit 1',
          })
        );
        expect(first?.failed).toBe(false);
      });

      it('credits the dump and the push of a chained run whose later command failed', () => {
        const { dumps, pushes } = activityOf(
          shellCall(CHAINED, { result: WRITTEN, error: 'exit 1' }),
          PUSH
        );
        expect(
          checkDumpedBeforePush(true, dumps, pushes, scanOf())
        ).toMatchObject({ passed: true });
      });

      it.each([
        ['a tool error and no output', { error: 'exit 1' }],
        [
          'a pg_dump error and no success text',
          { result: PG_DUMP_ERROR, error: 'exit 1' },
        ],
        [
          'an unlinked repo and no success text',
          { result: UNLINKED, error: 'exit 1' },
        ],
        [
          'a dump redirected to stdout, which prints no success text',
          { result: 'Dumping data from remote database...', error: 'exit 1' },
        ],
      ])('still marks the dump failed on %s', (_, options) => {
        const [first] = dumpsOf(
          shellCall(`${DUMP} && grep -c "^COPY" backups/pre-drop.sql`, options)
        );
        expect(first?.failed).toBe(true);
        expect(first?.failure).toBeDefined();
      });

      it('marks a redirected dump failed when a later command in its call errored', () => {
        const [first] = dumpsOf(
          shellCall(
            'supabase db dump --data-only > backups/pre-drop.sql && grep -c "^COPY" backups/pre-drop.sql',
            { error: 'exit 1' }
          )
        );
        expect(first?.failed).toBe(true);
      });
    });

    describe('when the call also dry-runs a dump', () => {
      const DRY_AND_REAL = `supabase db dump --dry-run -f backups/pre-drop.sql && ${DUMP}`;
      const DRY_RUN_OUTPUT = 'Dumped schema to backups/pre-drop.sql.';

      it('does not credit the real dump that failed after the dry run printed the success text', () => {
        const dumps = dumpsOf(
          shellCall(DRY_AND_REAL, {
            result: `${DRY_RUN_OUTPUT}\n${PG_DUMP_ERROR}`,
            error: 'exit 1',
          })
        );
        expect(dumps.map(({ failed }) => failed)).toEqual([true, true]);
        expect(dumps[1]?.failure).toBe(PG_DUMP_ERROR);
        expect(dumps.some((dump) => isCreditedDump(dump, scanOf()))).toBe(
          false
        );
      });

      it('does not credit the real dump when only the output shows the failure', () => {
        const dumps = dumpsOf(
          shellCall(`${DRY_AND_REAL} || true`, {
            result: `${DRY_RUN_OUTPUT}\n${UNLINKED}`,
          })
        );
        expect(dumps.some((dump) => isCreditedDump(dump, scanOf()))).toBe(
          false
        );
      });

      it('credits the real dump when the call shows no failure', () => {
        const dumps = dumpsOf(
          shellCall(DRY_AND_REAL, {
            result: `${DRY_RUN_OUTPUT}\n${DRY_RUN_OUTPUT}`,
          })
        );
        expect(dumps.map(({ failed }) => failed)).toEqual([false, false]);
        expect(dumps.map((dump) => isCreditedDump(dump, scanOf()))).toEqual([
          false,
          true,
        ]);
      });

      it('still reads the success text of a call that dry-runs a push', () => {
        const [first] = dumpsOf(
          shellCall(`supabase db push --dry-run && ${CHAINED_DUMP}`, {
            result: DRY_RUN_OUTPUT,
            error: 'exit 1',
          })
        );
        expect(first?.failed).toBe(false);
      });
    });

    it('reads the output of the tool call the dump ran in, not of another call', () => {
      const dumps = dumpsOf(
        shellCall('supabase migration list --linked', { result: UNLINKED }),
        shellCall(DUMP, { result: 'Dumped schema to backups/pre-drop.sql' })
      );
      expect(dumps.map(({ failed }) => failed)).toEqual([false]);
    });

    it('does not read a dump failure in the output of a dry run call as another dump failing', () => {
      const dumps = dumpsOf(
        shellCall('supabase db dump --dry-run', { result: 'dry run output' }),
        shellCall(DUMP, { result: '' })
      );
      expect(dumps.map(({ failed }) => failed)).toEqual([false, false]);
    });
  });
});

describe('isCreditedDump', () => {
  it.each([
    ['a plain dump with no file', dumpOf(), false],
    ['a data-only dump', dumpOf({ dataOnly: true }), true],
    [
      'a dump with every flag unset, as a bare db dump',
      dumpOf({ order: 3 }),
      false,
    ],
    ['a data-only dry run', dumpOf({ dataOnly: true, dryRun: true }), false],
    [
      'a data-only role-only dump',
      dumpOf({ dataOnly: true, roleOnly: true }),
      false,
    ],
    [
      'an explicitly local data-only dump',
      dumpOf({ dataOnly: true, explicitlyLocal: true }),
      false,
    ],
    [
      'a failed data-only dump',
      dumpOf({ dataOnly: true, failed: true }),
      false,
    ],
    [
      'a failed data-only dump with its failure line',
      dumpOf({ dataOnly: true, failed: true, failure: UNLINKED }),
      false,
    ],
  ])('classifies %s', (_, dump, credited) => {
    expect(isCreditedDump(dump, scanOf())).toBe(credited);
  });
});

describe('checkDumpedBeforePush', () => {
  const list = (kinds: string[]) => new Intl.ListFormat('en').format(kinds);
  const dataDump = (overrides: Partial<DbDump> = {}) =>
    dumpOf({ dataOnly: true, ...overrides });
  const check = (
    dumps = [dataDump()],
    pushes = [pushOf({ order: 1 })],
    hosted = true
  ) => checkDumpedBeforePush(hosted, dumps, pushes, scanOf());

  it('passes for a credited dump before a credited push', () => {
    expect(check()).toMatchObject({ name: DUMP_CHECK_NAME, passed: true });
  });

  it('fails with NO_HOSTED_PROJECT, whatever the dumps and pushes, when there is no hosted project', () => {
    expect(check([dataDump()], [pushOf({ order: 1 })], false)).toEqual({
      name: DUMP_CHECK_NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
    expect(checkDumpedBeforePush(false, [], [], scanOf())).toEqual({
      name: DUMP_CHECK_NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
  });

  describe('when no dump counts', () => {
    it('says no dump ran when there is none', () => {
      expect(check([], [pushOf()])).toEqual({
        name: DUMP_CHECK_NAME,
        passed: false,
        notes: 'no supabase db dump ran',
      });
      expect(check([], [])).toMatchObject({
        passed: false,
        notes: 'no supabase db dump ran',
      });
    });

    it.each([
      ['a dry run', dumpOf({ dryRun: true }), 'dry-run'],
      ['a role-only dump', dumpOf({ roleOnly: true }), 'role-only'],
      ['a local dump', dumpOf({ explicitlyLocal: true }), 'local'],
    ])('names only %s', (_, dump, kind) => {
      expect(check([dump])).toEqual({
        name: DUMP_CHECK_NAME,
        passed: false,
        notes: `only ${kind} supabase db dump ran`,
      });
    });

    it('names a failed dump and quotes its failure line', () => {
      expect(check([dumpOf({ failed: true, failure: UNLINKED })])).toEqual({
        name: DUMP_CHECK_NAME,
        passed: false,
        notes: `only failed supabase db dump ran; first failure: "${UNLINKED}"`,
      });
    });

    it('quotes nothing when the failed dump showed no line', () => {
      expect(check([dumpOf({ failed: true })]).notes).toBe(
        'only failed supabase db dump ran'
      );
    });

    it('names only the kinds present, in a fixed order', () => {
      expect(
        check([
          dumpOf({ explicitlyLocal: true }),
          dumpOf({ dryRun: true, order: 1 }),
        ]).notes
      ).toBe('only dry-run and local supabase db dump ran');
      expect(
        check([
          dumpOf({ roleOnly: true }),
          dumpOf({ failed: true, failure: 'exit 1', order: 1 }),
        ]).notes
      ).toBe(
        'only role-only and failed supabase db dump ran; first failure: "exit 1"'
      );
    });

    it('names all four kinds when all four ran', () => {
      expect(
        check([
          dumpOf({ dryRun: true }),
          dumpOf({ roleOnly: true, order: 1 }),
          dumpOf({ explicitlyLocal: true, order: 2 }),
          dumpOf({ failed: true, failure: UNLINKED, order: 3 }),
        ]).notes
      ).toBe(
        `only ${list(['dry-run', 'role-only', 'local', 'failed'])} supabase db dump ran; first failure: "${UNLINKED}"`
      );
    });

    it('quotes the failure of a dump that was not a dry run', () => {
      expect(
        check([
          dumpOf({ dryRun: true, failed: true, failure: 'dry-run boom' }),
          dumpOf({ failed: true, failure: 'exit 1', order: 1 }),
        ]).notes
      ).toBe(
        'only dry-run and failed supabase db dump ran; first failure: "exit 1"'
      );
    });

    it('quotes the first failure when several dumps failed', () => {
      expect(
        check([
          dumpOf({ failed: true, failure: UNLINKED }),
          dumpOf({ failed: true, failure: PG_DUMP_ERROR, order: 1 }),
        ]).notes
      ).toBe(`only failed supabase db dump ran; first failure: "${UNLINKED}"`);
    });

    it('fails even when a credited push follows, as the dump never counted', () => {
      expect(
        check([dumpOf({ dryRun: true })], [pushOf({ order: 1 })]).passed
      ).toBe(false);
    });
  });

  describe('order against the pushes', () => {
    const ORDER =
      'the first credited supabase db push ran before any credited supabase db dump';

    it('fails when the first credited push precedes the only credited dump', () => {
      expect(check([dataDump({ order: 1 })], [pushOf({ order: 0 })])).toEqual({
        name: DUMP_CHECK_NAME,
        passed: false,
        notes: ORDER,
      });
    });

    it('fails when the first credited push precedes every credited dump', () => {
      expect(
        check(
          [dataDump({ order: 2 }), dataDump({ order: 3 })],
          [pushOf({ order: 1 })]
        ).notes
      ).toBe(ORDER);
    });

    it('passes when a credited dump precedes the first credited push, though another dump follows it', () => {
      expect(
        check(
          [dataDump({ order: 0 }), dataDump({ order: 2 })],
          [pushOf({ order: 1 })]
        ).passed
      ).toBe(true);
    });

    it('passes when the credited dump comes after a push that did not count', () => {
      for (const early of [
        pushOf({ order: 0, dryRun: true }),
        pushOf({ order: 0, explicitlyLocal: true }),
        pushOf({ order: 0, failed: true }),
        pushOf({ order: 0, upToDate: true }),
      ]) {
        expect(
          check([dataDump({ order: 1 })], [early, pushOf({ order: 2 })]).passed
        ).toBe(true);
      }
    });

    it('fails when a failed dump, then a credited push, then a credited dump ran', () => {
      expect(
        check(
          [dumpOf({ order: 0, failed: true }), dataDump({ order: 2 })],
          [pushOf({ order: 1 })]
        ).notes
      ).toBe(ORDER);
    });

    it('passes when a failed dump is followed by a credited dump and then the push', () => {
      expect(
        check(
          [
            dumpOf({ order: 0, failed: true, failure: UNLINKED }),
            dataDump({ order: 1 }),
          ],
          [pushOf({ order: 2 })]
        ).passed
      ).toBe(true);
    });

    it('passes when a role-only dump, then a data dump, then the push ran', () => {
      expect(
        check(
          [dumpOf({ order: 0, roleOnly: true }), dataDump({ order: 1 })],
          [pushOf({ order: 2 })]
        ).passed
      ).toBe(true);
    });

    it('fails when only a role-only dump precedes the push', () => {
      expect(
        check([dumpOf({ order: 0, roleOnly: true })], [pushOf({ order: 1 })])
          .passed
      ).toBe(false);
    });

    it('passes a credited dump with no push at all, leaving the push check to fail that run', () => {
      expect(check([dataDump()], []).passed).toBe(true);
    });

    it('passes a credited dump when no push counted', () => {
      expect(
        check(
          [dataDump({ order: 0 })],
          [
            pushOf({ order: 1, dryRun: true }),
            pushOf({ order: 2, failed: true }),
          ]
        ).passed
      ).toBe(true);
    });
  });

  describe('from commands', () => {
    const verdictOf = (...calls: Call[]) => {
      const { dumps, pushes } = activityOf(...calls);
      return checkDumpedBeforePush(true, dumps, pushes, scanOf());
    };

    it.each([
      ['a data-only dump to a file, then a push', [DUMP, PUSH]],
      ['both in one chained command', [`${DUMP} && ${PUSH}`]],
      [
        'npx for both',
        [
          'npx supabase db dump --linked --data-only -f x.sql',
          'npx supabase db push',
        ],
      ],
      ['--linked', ['supabase db dump --linked --data-only -f x.sql', PUSH]],
      [
        'a remote --db-url',
        [
          `supabase db dump --db-url "${POOLER_URL}" --data-only -f x.sql`,
          PUSH,
        ],
      ],
      ['--remote', ['supabase db dump --remote --data-only -f x.sql', PUSH]],
      [
        'a stdout redirect',
        ['supabase db dump --data-only > backups/x.sql', PUSH],
      ],
      [
        'a gzip pipe',
        ['supabase db dump --data-only | gzip > backups/x.sql.gz', PUSH],
      ],
      [
        'a bare data-only dump',
        ['supabase db dump --data-only', 'supabase db push'],
      ],
      [
        'a dry run of the dump first',
        ['supabase db dump --dry-run', DUMP, PUSH],
      ],
      ['a dump and no push', [DUMP]],
      [
        'a failed dump, a link, then a dump that worked and the push',
        [
          shellCall('supabase db dump -f x.sql', { error: UNLINKED }),
          `supabase link --project-ref ${HOSTED_REF}`,
          DUMP,
          PUSH,
        ],
      ],
      [
        'the dump before a dry-run push and the real push',
        [DUMP, 'supabase db push --dry-run --linked', PUSH],
      ],
      [
        'a push that failed before the dump',
        [failedShellCall('supabase db push --linked'), DUMP, PUSH],
      ],
      [
        'a dump before the push and another dump after it',
        [DUMP, PUSH, 'supabase db dump -f after.sql'],
      ],
    ] as [string, Call[]][])('passes for %s', (_, calls) => {
      expect(verdictOf(...calls)).toMatchObject({
        name: DUMP_CHECK_NAME,
        passed: true,
      });
    });

    it.each([
      ['the push before the dump', [PUSH, DUMP]],
      ['the push before the dump in one command', [`${PUSH} && ${DUMP}`]],
      ['only a dry run', ['supabase db dump --dry-run', PUSH]],
      ['only a local dump', ['supabase db dump --local -f x.sql', PUSH]],
      [
        'only a dump of a loopback --db-url',
        [`supabase db dump --db-url "${LOCAL_URL}" -f x.sql`, PUSH],
      ],
      [
        'only a role-only dump',
        ['supabase db dump --role-only -f roles.sql', PUSH],
      ],
      [
        'only a dump that failed on an unlinked repo',
        [shellCall('supabase db dump -f x.sql', { error: UNLINKED }), PUSH],
      ],
      [
        'only a dump whose pipe hid a pg_dump error',
        [
          shellCall('supabase db dump 2>&1 | tee x.sql', {
            result: PG_DUMP_ERROR,
          }),
          PUSH,
        ],
      ],
      [
        'only a dump the missing Docker daemon stopped',
        [shellCall(DUMP, { result: NO_DOCKER }), PUSH],
      ],
      ['no dump at all', [PUSH]],
      [
        'pg_dump run by hand instead of supabase db dump',
        [`pg_dump "${DIRECT_URL}" > backups/x.sql`, PUSH],
      ],
      [
        'a dump after a failed dump that came after the push',
        [
          PUSH,
          shellCall('supabase db dump -f x.sql', { error: UNLINKED }),
          DUMP,
        ],
      ],
    ] as [string, Call[]][])('fails for %s', (_, calls) => {
      expect(verdictOf(...calls)).toMatchObject({
        name: DUMP_CHECK_NAME,
        passed: false,
      });
    });

    it('words the failure of a dump that failed and was never retried', () => {
      expect(
        verdictOf(
          shellCall('supabase db dump -f x.sql', { error: UNLINKED }),
          PUSH
        ).notes
      ).toBe(`only failed supabase db dump ran; first failure: "${UNLINKED}"`);
    });

    it('says the push came first when the dump ran after it', () => {
      expect(verdictOf(PUSH, DUMP).notes).toBe(
        'the first credited supabase db push ran before any credited supabase db dump'
      );
    });
  });
});

const HOME = '/home/agent';
const SCHEMA_ONLY =
  "only a schema-only supabase db dump ran (no --data-only, and no complete backup from a dump's file)";

const homeScan = (...files: ReturnType<typeof file>[]): BackupScan => ({
  ok: true,
  files,
  home: HOME,
});

describe('output files of a dump', () => {
  const filesOf = (command: string, cwd?: string) =>
    dumpsOf(shellCall(command, { cwd })).map((dump) => dump.files);

  it.each([
    ['-f', 'supabase db dump -f backup.sql', [`${WORKSPACE}/backup.sql`]],
    [
      '--file',
      'supabase db dump --file backup.sql',
      [`${WORKSPACE}/backup.sql`],
    ],
    [
      '--file=',
      'supabase db dump --file=backup.sql',
      [`${WORKSPACE}/backup.sql`],
    ],
    [
      'a > redirect',
      'supabase db dump > backup.sql',
      [`${WORKSPACE}/backup.sql`],
    ],
    [
      'a >> redirect',
      'supabase db dump >> backup.sql',
      [`${WORKSPACE}/backup.sql`],
    ],
    [
      'a quoted redirect target',
      'supabase db dump > "my backup.sql"',
      [`${WORKSPACE}/my backup.sql`],
    ],
    [
      'a gzip pipe',
      'supabase db dump | gzip > backup.sql.gz',
      [`${WORKSPACE}/backup.sql.gz`],
    ],
    [
      'gzip -c',
      'supabase db dump | gzip -c > backup.sql.gz',
      [`${WORKSPACE}/backup.sql.gz`],
    ],
    [
      'a bzip2 pipe',
      'supabase db dump | bzip2 > backup.sql.bz2',
      [`${WORKSPACE}/backup.sql.bz2`],
    ],
    [
      'an xz pipe',
      'supabase db dump | xz > backup.sql.xz',
      [`${WORKSPACE}/backup.sql.xz`],
    ],
    [
      'a zstd pipe',
      'supabase db dump | zstd > backup.sql.zst',
      [`${WORKSPACE}/backup.sql.zst`],
    ],
    [
      'a gzip pipe after 2>&1',
      'supabase db dump 2>&1 | gzip > backup.sql.gz',
      [`${WORKSPACE}/backup.sql.gz`],
    ],
    ['tee', 'supabase db dump | tee backup.sql', [`${WORKSPACE}/backup.sql`]],
    [
      'tee -a',
      'supabase db dump | tee -a backup.sql',
      [`${WORKSPACE}/backup.sql`],
    ],
    [
      'an absolute path',
      'supabase db dump -f /var/backups/b.sql',
      ['/var/backups/b.sql'],
    ],
    [
      'a ~/ path, kept for the scan home',
      'supabase db dump --file=~/b.sql',
      ['~/b.sql'],
    ],
    ['a ../ path', 'supabase db dump -f ../b.sql', ['/tmp/b.sql']],
    [
      'a file and a redirect',
      'supabase db dump -f a.sql > b.sql',
      [`${WORKSPACE}/a.sql`, `${WORKSPACE}/b.sql`],
    ],
  ])('reads %s', (_, command, files) => {
    expect(filesOf(command)).toEqual([files]);
  });

  it.each([
    ['no file at all', 'supabase db dump'],
    [
      'a redirect of a later command',
      'supabase db dump && echo done > log.txt',
    ],
    ['a redirect after a pipe to a filter', 'supabase db dump | head > x.sql'],
    ['a redirect after a ;', 'supabase db dump; gzip > x.gz'],
    ['a tee of a later command', 'supabase db dump && ls | tee list.txt'],
    ['an unset $VAR target', 'supabase db dump > "$OUT"'],
  ])('reads no file for %s', (_, command) => {
    expect(filesOf(command)).toEqual([[]]);
  });

  it('resolves a relative path against the tool call cwd', () => {
    expect(filesOf('supabase db dump > x.sql', '/home/agent/app')).toEqual([
      ['/home/agent/app/x.sql'],
    ]);
  });

  it('resolves a relative path against a cd earlier in the command', () => {
    expect(
      filesOf('cd sub && supabase db dump -f x.sql', '/home/agent/app')
    ).toEqual([['/home/agent/app/sub/x.sql']]);
    expect(filesOf('cd sub && supabase db dump > x.sql')).toEqual([
      [`${WORKSPACE}/sub/x.sql`],
    ]);
  });

  it('gives each dump of one command its own files', () => {
    expect(
      filesOf(
        'supabase db dump | gzip > a.sql.gz && supabase db migration list && supabase db dump -f b.sql | tee c.sql'
      )
    ).toEqual([
      [`${WORKSPACE}/a.sql.gz`],
      [`${WORKSPACE}/b.sql`, `${WORKSPACE}/c.sql`],
    ]);
  });
});

describe('isCreditedDump for a dump that is not --data-only', () => {
  const creditedBy = (command: string, scan: BackupScan, cwd?: string) =>
    dumpsOf(shellCall(command, { cwd })).map((dump) =>
      isCreditedDump(dump, scan)
    );

  it.each([
    ['-f backup.sql', 'supabase db dump -f backup.sql', 'backup.sql'],
    ['--file backup.sql', 'supabase db dump --file backup.sql', 'backup.sql'],
    ['--file=backup.sql', 'supabase db dump --file=backup.sql', 'backup.sql'],
    ['> backup.sql', 'supabase db dump > backup.sql', 'backup.sql'],
    ['>> backup.sql', 'supabase db dump >> backup.sql', 'backup.sql'],
    [
      '| gzip > backup.sql.gz',
      'supabase db dump | gzip > backup.sql.gz',
      'backup.sql.gz',
    ],
    [
      '| gzip -c > backup.sql.gz',
      'supabase db dump | gzip -c > backup.sql.gz',
      'backup.sql.gz',
    ],
    ['| tee backup.sql', 'supabase db dump | tee backup.sql', 'backup.sql'],
  ])(
    'credits %s when the scan lists it complete, not when partial or unlisted',
    (_, command, path) => {
      expect(creditedBy(command, scanOf(file(path)))).toEqual([true]);
      expect(creditedBy(command, scanOf(file(path, 9, 8)))).toEqual([false]);
      expect(creditedBy(command, scanOf(file('other.sql')))).toEqual([false]);
      expect(creditedBy(command, scanOf())).toEqual([false]);
    }
  );

  it('credits --file=~/b.sql when the scan lists it complete under the scan home, not when partial or unlisted', () => {
    const command = 'supabase db dump --file=~/b.sql';
    const at = (codes: number, dates: number, name = 'b.sql') => ({
      path: `${HOME}/${name}`,
      codes,
      dates,
    });

    expect(creditedBy(command, homeScan(at(15, 12)))).toEqual([true]);
    expect(creditedBy(command, homeScan(at(9, 8)))).toEqual([false]);
    expect(creditedBy(command, homeScan(at(15, 12, 'c.sql')))).toEqual([false]);
  });

  it('resolves a relative path against the tool call cwd', () => {
    const scan = scanOf({
      path: '/home/agent/app/x.sql',
      codes: 15,
      dates: 12,
    });

    expect(
      creditedBy('supabase db dump > x.sql', scan, '/home/agent/app')
    ).toEqual([true]);
    expect(creditedBy('supabase db dump > x.sql', scan)).toEqual([true]);
  });

  it('credits a file the scan lists with a compression suffix added', () => {
    expect(
      creditedBy(
        'supabase db dump -f backup.sql',
        scanOf(file('backup.sql.gz'))
      )
    ).toEqual([true]);
    expect(
      creditedBy(
        'supabase db dump | gzip > backup.sql',
        scanOf(file('backup.sql.zst'))
      )
    ).toEqual([true]);
  });

  it('credits a unique basename among the complete backups, as after a cd', () => {
    const command = 'cd ../elsewhere && supabase db dump > backup.sql';

    expect(creditedBy(command, scanOf(file('deep/dir/backup.sql')))).toEqual([
      true,
    ]);
    expect(creditedBy(command, scanOf(file('deep/dir/backup.sql.gz')))).toEqual(
      [true]
    );
  });

  it('does not credit a basename shared by several complete backups, unless one is the exact path', () => {
    const command = 'cd ../elsewhere && supabase db dump > backup.sql';
    const twins = [file('a/backup.sql'), file('b/backup.sql')];

    expect(creditedBy(command, scanOf(...twins))).toEqual([false]);
    expect(
      creditedBy('supabase db dump > a/backup.sql', scanOf(...twins))
    ).toEqual([true]);
  });

  it('does not credit a basename held only by a partial backup', () => {
    expect(
      creditedBy(
        'cd ../elsewhere && supabase db dump > backup.sql',
        scanOf(file('deep/backup.sql', 9, 8), file('other/backup.sql', 15, 0))
      )
    ).toEqual([false]);
  });

  it('does not credit a plain dump when the scan failed', () => {
    expect(
      creditedBy('supabase db dump -f backup.sql', {
        ok: false,
        notes: 'exit 1',
      })
    ).toEqual([false]);
  });

  it('credits a --data-only dump whatever the scan lists', () => {
    expect(
      creditedBy('supabase db dump --data-only -f backup.sql', scanOf())
    ).toEqual([true]);
    expect(
      creditedBy('supabase db dump --data-only', { ok: false, notes: 'exit 1' })
    ).toEqual([true]);
  });

  it('does not credit a complete file that no dump wrote', () => {
    const { dumps } = activityOf(
      'supabase db dump -f schema.sql',
      'supabase db query "select * from legacy_coupons" > coupons.csv'
    );

    expect(
      dumps.map((dump) => isCreditedDump(dump, scanOf(file('coupons.csv'))))
    ).toEqual([false]);
  });

  it.each([
    ['a dry run', 'supabase db dump --dry-run -f backup.sql'],
    ['a role-only dump', 'supabase db dump --role-only -f backup.sql'],
    ['a local dump', 'supabase db dump --local -f backup.sql'],
  ])('still does not credit %s that wrote a complete file', (_, command) => {
    expect(creditedBy(command, scanOf(file('backup.sql')))).toEqual([false]);
  });
});

describe('checkDumpedBeforePush for a schema-only dump', () => {
  const verdictOf = (scan: BackupScan, ...calls: Call[]) => {
    const { dumps, pushes } = activityOf(...calls);
    return checkDumpedBeforePush(true, dumps, pushes, scan);
  };

  it('fails a schema-only dump next to a db query of the data, whose file is complete', () => {
    expect(
      verdictOf(
        scanOf(file('coupons.csv')),
        'supabase db dump -f schema.sql',
        'supabase db query "select * from legacy_coupons" > coupons.csv',
        'supabase db push'
      )
    ).toEqual({ name: DUMP_CHECK_NAME, passed: false, notes: SCHEMA_ONLY });
  });

  it('fails a bare schema-only dump with the same note', () => {
    expect(verdictOf(scanOf(), 'supabase db dump', PUSH).notes).toBe(
      SCHEMA_ONLY
    );
  });

  it('words a schema-only dump next to the other kinds that did not count', () => {
    expect(
      verdictOf(
        scanOf(),
        'supabase db dump --dry-run',
        'supabase db dump -f schema.sql',
        PUSH
      ).notes
    ).toBe(
      "only dry-run and schema-only supabase db dump ran (no --data-only, and no complete backup from a dump's file)"
    );
  });

  it('passes a dump whose file the scan lists complete, then the push', () => {
    expect(
      verdictOf(
        scanOf(file('backup.sql')),
        'supabase db dump -f backup.sql',
        PUSH
      ).passed
    ).toBe(true);
  });

  it('passes a --data-only dump, then the push, whatever the scan lists', () => {
    expect(verdictOf(scanOf(), DUMP, PUSH).passed).toBe(true);
  });

  it('still fails when the push came before the dump that wrote the complete file', () => {
    expect(
      verdictOf(
        scanOf(file('backup.sql')),
        PUSH,
        'supabase db dump > backup.sql'
      ).notes
    ).toBe(
      'the first credited supabase db push ran before any credited supabase db dump'
    );
  });
});
