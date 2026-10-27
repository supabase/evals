// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/deploy-database-007-dump-before-push
import { describe, expect, it } from 'vitest';
import {
  type Call,
  activityOf,
  dumpOf,
  failedShellCall,
  HOSTED_REF,
  pushOf,
  shellCall,
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

const LOCAL_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const POOLER_URL =
  'postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
const DIRECT_URL = `postgresql://postgres:pw@db.${HOSTED_REF}.supabase.co:5432/postgres`;
const CONTAINER_URL =
  'postgresql://postgres:postgres@supabase_db_shop-app:5432/postgres';

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
      dumpOf(),
    ]);
  });

  it('reads a bare dump', () => {
    expect(dumpsOf('supabase db dump')).toEqual([dumpOf()]);
  });

  it('numbers an invocation by its place among all supabase invocations', () => {
    expect(
      dumpsOf('supabase migration list --linked', 'supabase db dump -f x.sql')
    ).toEqual([dumpOf({ order: 1 })]);
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
        dumpOf({ dataOnly: true, failed: true, failure: FLAG_GROUP_CONFLICT }),
      ]);
      expect(dumps.some(isCreditedDump)).toBe(false);
      expect(checkDumpedBeforePush(true, dumps, pushes)).toMatchObject({
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
        expect(first).toEqual(dumpOf({ dataOnly: true }));
        expect(first).not.toHaveProperty('failure');
        expect(isCreditedDump(first as DbDump)).toBe(true);
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
        expect(checkDumpedBeforePush(true, dumps, pushes)).toMatchObject({
          passed: true,
        });
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
        expect(dumps.some(isCreditedDump)).toBe(false);
      });

      it('does not credit the real dump when only the output shows the failure', () => {
        const dumps = dumpsOf(
          shellCall(`${DRY_AND_REAL} || true`, {
            result: `${DRY_RUN_OUTPUT}\n${UNLINKED}`,
          })
        );
        expect(dumps.some(isCreditedDump)).toBe(false);
      });

      it('credits the real dump when the call shows no failure', () => {
        const dumps = dumpsOf(
          shellCall(DRY_AND_REAL, {
            result: `${DRY_RUN_OUTPUT}\n${DRY_RUN_OUTPUT}`,
          })
        );
        expect(dumps.map(({ failed }) => failed)).toEqual([false, false]);
        expect(dumps.map(isCreditedDump)).toEqual([false, true]);
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
    ['a plain dump', dumpOf(), true],
    ['a data-only dump', dumpOf({ dataOnly: true }), true],
    [
      'a dump with every flag unset, as a bare db dump',
      dumpOf({ order: 3 }),
      true,
    ],
    ['a dry run', dumpOf({ dryRun: true }), false],
    ['a role-only dump', dumpOf({ roleOnly: true }), false],
    ['an explicitly local dump', dumpOf({ explicitlyLocal: true }), false],
    ['a failed dump', dumpOf({ failed: true }), false],
    [
      'a failed dump with its failure line',
      dumpOf({ failed: true, failure: UNLINKED }),
      false,
    ],
    [
      'a data-only dump that is also a dry run',
      dumpOf({ dataOnly: true, dryRun: true }),
      false,
    ],
  ])('classifies %s', (_, dump, credited) => {
    expect(isCreditedDump(dump)).toBe(credited);
  });
});

describe('checkDumpedBeforePush', () => {
  const list = (kinds: string[]) => new Intl.ListFormat('en').format(kinds);
  const check = (
    dumps = [dumpOf()],
    pushes = [pushOf({ order: 1 })],
    hosted = true
  ) => checkDumpedBeforePush(hosted, dumps, pushes);

  it('passes for a credited dump before a credited push', () => {
    expect(check()).toMatchObject({ name: DUMP_CHECK_NAME, passed: true });
  });

  it('fails with NO_HOSTED_PROJECT, whatever the dumps and pushes, when there is no hosted project', () => {
    expect(check([dumpOf()], [pushOf({ order: 1 })], false)).toEqual({
      name: DUMP_CHECK_NAME,
      passed: false,
      notes: NO_HOSTED_PROJECT,
    });
    expect(checkDumpedBeforePush(false, [], [])).toEqual({
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
      expect(check([dumpOf({ order: 1 })], [pushOf({ order: 0 })])).toEqual({
        name: DUMP_CHECK_NAME,
        passed: false,
        notes: ORDER,
      });
    });

    it('fails when the first credited push precedes every credited dump', () => {
      expect(
        check(
          [dumpOf({ order: 2 }), dumpOf({ order: 3 })],
          [pushOf({ order: 1 })]
        ).notes
      ).toBe(ORDER);
    });

    it('passes when a credited dump precedes the first credited push, though another dump follows it', () => {
      expect(
        check(
          [dumpOf({ order: 0 }), dumpOf({ order: 2 })],
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
          check([dumpOf({ order: 1 })], [early, pushOf({ order: 2 })]).passed
        ).toBe(true);
      }
    });

    it('fails when a failed dump, then a credited push, then a credited dump ran', () => {
      expect(
        check(
          [dumpOf({ order: 0, failed: true }), dumpOf({ order: 2 })],
          [pushOf({ order: 1 })]
        ).notes
      ).toBe(ORDER);
    });

    it('passes when a failed dump is followed by a credited dump and then the push', () => {
      expect(
        check(
          [
            dumpOf({ order: 0, failed: true, failure: UNLINKED }),
            dumpOf({ order: 1 }),
          ],
          [pushOf({ order: 2 })]
        ).passed
      ).toBe(true);
    });

    it('passes when a role-only dump, then a data dump, then the push ran', () => {
      expect(
        check(
          [dumpOf({ order: 0, roleOnly: true }), dumpOf({ order: 1 })],
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
      expect(check([dumpOf()], []).passed).toBe(true);
    });

    it('passes a credited dump when no push counted', () => {
      expect(
        check(
          [dumpOf({ order: 0 })],
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
      return checkDumpedBeforePush(true, dumps, pushes);
    };

    it.each([
      ['a data-only dump to a file, then a push', [DUMP, PUSH]],
      ['both in one chained command', [`${DUMP} && ${PUSH}`]],
      [
        'npx for both',
        ['npx supabase db dump --linked -f x.sql', 'npx supabase db push'],
      ],
      ['--linked', ['supabase db dump --linked -f x.sql', PUSH]],
      [
        'a remote --db-url',
        [`supabase db dump --db-url "${POOLER_URL}" -f x.sql`, PUSH],
      ],
      ['--remote', ['supabase db dump --remote -f x.sql', PUSH]],
      [
        'a stdout redirect',
        ['supabase db dump --data-only > backups/x.sql', PUSH],
      ],
      [
        'a gzip pipe',
        ['supabase db dump --data-only | gzip > backups/x.sql.gz', PUSH],
      ],
      ['a bare dump', ['supabase db dump -f x.sql', 'supabase db push']],
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
