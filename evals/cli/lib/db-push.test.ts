// Run: pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/lib/db-push.test.ts
import type { ToolCallRecord } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { findSupabaseInvocations } from './cli-invocations.js';
import {
  type DbPush,
  checkPushed,
  describePushes,
  isCreditedPush,
  isRealPush,
  PUSH_CHECK_NAME,
  readDbPushes,
} from './db-push.js';
import { extractCommandEntries } from './detours.js';

type Call = string | ToolCallRecord;

function shellCall(
  command: string,
  options: { error?: string; result?: string } = {}
): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result: options.result ?? (options.error === undefined ? '' : undefined),
    ts: 0,
    ...(options.error === undefined ? {} : { error: options.error }),
  };
}

const failedShellCall = (command: string) =>
  shellCall(command, { error: 'exit 1' });

const toCalls = (calls: readonly Call[]) =>
  calls.map((call) => (typeof call === 'string' ? shellCall(call) : call));

const pushesOf = (...calls: Call[]) => {
  const toolCalls = toCalls(calls);
  return readDbPushes(
    findSupabaseInvocations(extractCommandEntries(toolCalls)),
    toolCalls
  );
};

const HOSTED_REF = 'abcdefghijklmnopqrst';
const LOCAL_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const POOLER_URL =
  'postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
const DIRECT_URL = `postgresql://postgres:pw@db.${HOSTED_REF}.supabase.co:5432/postgres`;

const PUSH = 'supabase db push --linked --yes';
const APPLIED =
  'Applying migration 20261027090000_drop_legacy_coupons.sql...\nFinished supabase db push.';
const UP_TO_DATE = 'Remote database is up to date.';
const UP_TO_DATE_JSON =
  '{"_tag":"Success","message":"Remote database is up to date.","data":{"upToDate":true,"dryRun":false,"migrations":[]}}';
const UNLINKED_ERROR =
  '{"_tag":"Error","error":{"code":"ProjectRefNotLinkedError","message":"Cannot find project ref. Have you run supabase link?"}}';
const WRAPPER_CONFLICT =
  'if any flags in the group [db-url linked local] are set none of the others can be; [db-url linked] were all set';

const CLI_FAILURES: [label: string, output: string][] = [
  ['a JSON error', '{"_tag":"Error","error":{"code":1,"message":"boom"}}'],
  ['an unlinked repo', 'Cannot find project ref. Have you run supabase link?'],
  ['a missing token', 'Access token not provided. Supply an access token.'],
  [
    'a stopped confirmation',
    'Confirmation required: push migrations on remote. Nothing was changed.',
  ],
  ['a refused connection', 'failed to connect to postgres'],
  ['an unknown flag', 'unknown flag: --remote'],
  ['a missing binary', 'zsh: command not found: supabase'],
  ['a different case', 'CANNOT FIND PROJECT REF'],
  [
    'an HTTP status in text mode',
    'unexpected status 401: {"message":"Unauthorized"}',
  ],
  ['a flag-group conflict', WRAPPER_CONFLICT],
];

const push = (overrides: Partial<DbPush> = {}): DbPush => ({
  order: 0,
  dryRun: false,
  explicitlyLocal: false,
  yes: false,
  failed: false,
  upToDate: false,
  ...overrides,
});

describe('readDbPushes', () => {
  it('reads a push with --yes', () => {
    expect(pushesOf('supabase db push --linked --yes')).toEqual([
      {
        order: 0,
        dryRun: false,
        explicitlyLocal: false,
        yes: true,
        failed: false,
        upToDate: false,
      },
    ]);
  });

  it('numbers an invocation by its place among all supabase invocations', () => {
    expect(
      pushesOf('supabase migration list --linked', 'supabase db push')
    ).toEqual([push({ order: 1 })]);
  });

  it('counts a db dump before the push in the push order', () => {
    expect(
      pushesOf('supabase db dump -f backup.sql && supabase db push --yes')
    ).toEqual([push({ order: 1, yes: true })]);
  });

  it('numbers invocations inside one command in the order they run', () => {
    const pushes = pushesOf(
      'supabase db push --dry-run && supabase db push --yes'
    );
    expect(
      pushes.map(({ order, dryRun, yes }) => [order, dryRun, yes])
    ).toEqual([
      [0, true, false],
      [1, false, true],
    ]);
  });

  it.each([
    ['--dry-run', true],
    ['--dry-run=true', true],
    ['--dry-run=false', false],
    ['--yes', false],
  ])('reads %s as dryRun %s', (flag, dryRun) => {
    expect(pushesOf(`supabase db push ${flag}`)[0]?.dryRun).toBe(dryRun);
  });

  it.each([
    ['--yes', true],
    ['--yes=true', true],
    ['--yes=false', false],
    ['--linked', false],
  ])('reads %s as yes %s', (flag, yes) => {
    expect(pushesOf(`supabase db push ${flag}`)[0]?.yes).toBe(yes);
  });

  it('does not read a piped answer as --yes', () => {
    expect(pushesOf('echo y | npx supabase db push')).toEqual([push()]);
  });

  it.each([
    ['--local', '--local', true],
    ['--db-url on 127.0.0.1', `--db-url "${LOCAL_URL}"`, true],
    ['--remote=<url> on 127.0.0.1', `--remote="${LOCAL_URL}"`, true],
    ['--db-url on a pooler host', `--db-url "${POOLER_URL}"`, false],
    ['--remote=<url> on a direct host', `--remote="${DIRECT_URL}"`, false],
    ['--remote=<ref>', `--remote=${HOSTED_REF}`, false],
    ['--linked', '--linked', false],
    ['--project-ref', `--project-ref ${HOSTED_REF}`, false],
    ['no target flag', '', false],
    [
      'a $VAR --db-url with no assignment',
      '--db-url "$SUPABASE_DB_URL"',
      false,
    ],
  ])('reads %s as explicitlyLocal %s', (_, flags, explicitlyLocal) => {
    expect(pushesOf(`supabase db push ${flags}`)[0]?.explicitlyLocal).toBe(
      explicitlyLocal
    );
  });

  it('reads a --db-url from a variable that holds the local stack URL as local', () => {
    expect(
      pushesOf(
        'eval "$(supabase status -o env)" && supabase db push --db-url "$DB_URL"'
      )[0]?.explicitlyLocal
    ).toBe(true);
    expect(
      pushesOf(`DB_URL="${LOCAL_URL}"; supabase db push --db-url "$DB_URL"`)[0]
        ?.explicitlyLocal
    ).toBe(true);
  });

  it.each([
    ['a package runner pin', 'npx -y supabase@2.122.0 db push --linked'],
    ['an env assignment', 'SUPABASE_YES=1 supabase db push --include-all'],
    ['a directory change', 'cd app && supabase db push'],
    ['a piped answer', 'echo y | supabase db push'],
    ['an env wrapper', 'env FOO=1 supabase db push --linked'],
    ['a subshell', '(supabase db push --linked)'],
  ])('reads a push through %s', (_, command) => {
    expect(pushesOf(command)).toHaveLength(1);
  });

  describe('failure', () => {
    it('marks a push failed when its tool call reported an error', () => {
      const pushes = pushesOf(failedShellCall(PUSH), shellCall(PUSH));
      expect(pushes.map(({ failed }) => failed)).toEqual([true, false]);
    });

    it.each(CLI_FAILURES)(
      'marks a piped push failed when its output shows %s, with no tool error',
      (_, result) => {
        const pushes = pushesOf(
          shellCall('supabase db push 2>&1 | tail -20', { result })
        );
        expect(pushes[0]?.failed).toBe(true);
      }
    );

    it.each([
      ['a successful push', 'Finished supabase db push.'],
      ['a push with nothing to do', 'Remote database is up to date.'],
      ['an empty output', ''],
    ])('does not mark a push failed on %s', (_, result) => {
      const [first] = pushesOf(shellCall(PUSH, { result }));
      expect(first?.failed).toBe(false);
      expect(first).not.toHaveProperty('failure');
    });

    it('keeps the first line of the output that shows the failure', () => {
      const [first] = pushesOf(
        shellCall('supabase db push 2>&1 | tail -20', {
          result:
            'Connecting to remote database...\nCannot find project ref. Have you run supabase link?\nTry --help',
        })
      );
      expect(first).toMatchObject({
        failed: true,
        failure: 'Cannot find project ref. Have you run supabase link?',
      });
    });

    it('keeps the first line of the error text when the output shows no failure', () => {
      const [first] = pushesOf(
        shellCall(PUSH, { error: '\n  exit status 1\nsecond line' })
      );
      expect(first).toMatchObject({ failed: true, failure: 'exit status 1' });
    });

    it('trims the failure line to 200 characters', () => {
      const [first] = pushesOf(
        shellCall(PUSH, { error: `Cannot find project ref ${'x'.repeat(500)}` })
      );
      expect(first?.failure).toHaveLength(200);
    });

    it.each([
      [
        'a deprecation warning',
        `Warning: --linked is deprecated and will be removed in v4. Use --remote instead\n${UNLINKED_ERROR}`,
      ],
      [
        'an npx warning',
        `npm warn exec The following package was not found and will be installed: supabase@2.117.0\n${UNLINKED_ERROR}`,
      ],
    ])(
      'keeps the CLI failure line of the error text past %s, with no output',
      (_, error) => {
        const failing = shellCall('supabase db push --linked', { error });
        expect(failing.result).toBeUndefined();
        expect(pushesOf(failing)[0]).toMatchObject({
          failed: true,
          failure: UNLINKED_ERROR,
        });
      }
    );

    it('reads the output of the tool call the push ran in, not of another call', () => {
      const pushes = pushesOf(
        shellCall('supabase migration list --linked', {
          result: 'Cannot find project ref.',
        }),
        shellCall(PUSH, { result: 'Finished supabase db push.' })
      );
      expect(pushes.map(({ failed }) => failed)).toEqual([false]);
    });

    describe('when a later command in the same tool call fails', () => {
      const CHAINED =
        'supabase db push --yes && supabase migration list --linked';

      it('does not mark a push failed when its call printed that it finished, though the call errored on the flag-group conflict', () => {
        const [first] = pushesOf(
          shellCall(CHAINED, {
            result: `${APPLIED}\n${WRAPPER_CONFLICT}`,
            error: 'exit 1',
          })
        );
        expect(first).toEqual(push({ yes: true }));
        expect(first).not.toHaveProperty('failure');
        expect(isCreditedPush(first as DbPush)).toBe(true);
      });

      it('does not mark a push failed when the whole output is in the error text', () => {
        const [first] = pushesOf(
          shellCall(CHAINED, {
            error: `${APPLIED}\n${WRAPPER_CONFLICT}\nexit status 1`,
          })
        );
        expect(first).toMatchObject({ yes: true, failed: false });
        expect(first).not.toHaveProperty('failure');
      });

      it.each([
        ['plain text', 'Finished supabase db push.'],
        [
          'colour codes around the command',
          'Finished \x1b[36msupabase db push\x1b[0m.',
        ],
        [
          'compound colour codes',
          'Finished \x1b[1;36msupabase db push\x1b[22;39m.',
        ],
        ['a bare reset code', 'Finished \x1b[msupabase db push\x1b[m.'],
        [
          'colour codes around all of it',
          '\x1b[32mFinished \x1b[36msupabase db push\x1b[0m.\x1b[0m',
        ],
      ])('reads the success text with %s', (_, finished) => {
        const [first] = pushesOf(
          shellCall(CHAINED, {
            result: `Applying migration 20261027090000_drop_legacy_coupons.sql...\n${finished}\n${WRAPPER_CONFLICT}`,
            error: 'exit 1',
          })
        );
        expect(first?.failed).toBe(false);
      });

      it.each([
        ['a tool error and no output', { error: 'exit 1' }],
        [
          'the flag-group conflict and no success text',
          { result: WRAPPER_CONFLICT, error: 'exit 1' },
        ],
        [
          'an unlinked repo and no success text',
          { result: UNLINKED_ERROR, error: 'exit 1' },
        ],
        [
          'text that is not the push success text',
          { result: 'Finished supabase db pull.', error: 'exit 1' },
        ],
        [
          'a migration named like the success text',
          {
            result:
              'Applying migration 1_finished_supabase_db_push.sql...\nfailed to connect to postgres',
            error: 'exit 1',
          },
        ],
      ])('still marks the push failed on %s', (_, options) => {
        const [first] = pushesOf(shellCall(CHAINED, options));
        expect(first?.failed).toBe(true);
        expect(first?.failure).toBeDefined();
      });

      it('reads the output of the tool call the push ran in, not the finish text of another call', () => {
        const pushes = pushesOf(
          shellCall('supabase db push --dry-run', { result: APPLIED }),
          shellCall(PUSH, { error: 'exit 1' })
        );
        expect(pushes.map(({ failed }) => failed)).toEqual([false, true]);
      });
    });

    describe('when the call also dry-runs a push', () => {
      const DRY_AND_REAL = 'supabase db push --dry-run && supabase db push';
      const DRY_RUN_OUTPUT =
        'Would push migrations.\nFinished supabase db push.';
      const CONNECT_ERROR = 'failed to connect to postgres';

      it('does not credit the real push that failed after the dry run printed the success text', () => {
        const pushes = pushesOf(
          shellCall(DRY_AND_REAL, {
            result: `${DRY_RUN_OUTPUT}\n${CONNECT_ERROR}`,
            error: 'exit 1',
          })
        );
        expect(pushes.map(({ failed }) => failed)).toEqual([true, true]);
        expect(pushes[1]?.failure).toBe(CONNECT_ERROR);
        expect(checkPushed(pushes).passed).toBe(false);
      });

      it('does not credit the real push when only the output shows the failure', () => {
        const pushes = pushesOf(
          shellCall(`${DRY_AND_REAL} || true`, {
            result: `${DRY_RUN_OUTPUT}\n${CONNECT_ERROR}`,
          })
        );
        expect(checkPushed(pushes).passed).toBe(false);
      });

      it('credits the real push when the call shows no failure', () => {
        const pushes = pushesOf(
          shellCall(DRY_AND_REAL, { result: `${DRY_RUN_OUTPUT}\n${APPLIED}` })
        );
        expect(pushes.map(({ failed }) => failed)).toEqual([false, false]);
        expect(pushes.map(isCreditedPush)).toEqual([false, true]);
        expect(checkPushed(pushes).passed).toBe(true);
      });

      it('still reads the success text of a call that dry-runs another command', () => {
        const [first] = pushesOf(
          shellCall(
            'supabase db dump --dry-run -f a.sql && supabase db push --yes',
            { result: APPLIED, error: 'exit 1' }
          )
        );
        expect(first?.failed).toBe(false);
      });
    });

    it('does not read a dump failure line as a push failure', () => {
      const pushes = pushesOf(
        shellCall('supabase db push', {
          result: 'pg_dump: error: connection refused',
        })
      );
      expect(pushes[0]?.failed).toBe(false);
    });
  });

  describe('up to date', () => {
    it.each([
      ['the text output', UP_TO_DATE],
      ['the text output in another case', 'REMOTE DATABASE IS UP TO DATE.'],
      ['the JSON output', UP_TO_DATE_JSON],
      ['JSON output with spacing', '{ "upToDate" : true }'],
      [
        'a deprecation warning before it',
        `Warning: --db-url is deprecated\n${UP_TO_DATE}`,
      ],
    ])('marks a push up to date on %s', (_, result) => {
      expect(
        pushesOf(shellCall('supabase db push', { result }))[0]
      ).toMatchObject({ upToDate: true, failed: false });
    });

    it.each([
      ['a push that applied a migration', APPLIED],
      ['JSON output of a push that applied', '{"data":{"upToDate":false}}'],
      [
        'a migration named up_to_date',
        'Applying migration 1_up_to_date.sql...',
      ],
      ['an empty output', ''],
    ])('does not mark a push up to date on %s', (_, result) => {
      expect(
        pushesOf(shellCall('supabase db push', { result }))[0]?.upToDate
      ).toBe(false);
    });

    it('marks every push in one tool call up to date when its output says so', () => {
      const pushes = pushesOf(
        shellCall('supabase db push --yes && supabase db push', {
          result: `${APPLIED}\n${UP_TO_DATE}`,
        })
      );
      expect(pushes.map(({ upToDate }) => upToDate)).toEqual([true, true]);
    });

    it('keeps a push up to date when its call also printed that it finished', () => {
      const pushes = pushesOf(
        shellCall('supabase db push --yes && supabase db push', {
          result: `${APPLIED}\n${UP_TO_DATE}\n${WRAPPER_CONFLICT}`,
          error: 'exit 1',
        })
      );
      expect(pushes.map(({ upToDate, failed }) => [upToDate, failed])).toEqual([
        [true, false],
        [true, false],
      ]);
      expect(pushes.some(isCreditedPush)).toBe(false);
    });

    it('does not mark a push up to date when its tool call errored', () => {
      expect(pushesOf(failedShellCall('supabase db push'))[0]?.upToDate).toBe(
        false
      );
    });

    it('reads the output of the tool call the push ran in, not of another call', () => {
      const pushes = pushesOf(
        shellCall('supabase migration list --linked', { result: UP_TO_DATE }),
        shellCall(PUSH, { result: APPLIED })
      );
      expect(pushes.map(({ upToDate }) => upToDate)).toEqual([false]);
    });
  });

  it.each([
    ['a help request', 'supabase db push --help'],
    ['an echoed command line', 'echo "supabase db push --yes"'],
    ['a commented command line', '# supabase db push'],
    ['db dump', 'supabase db dump -f backup.sql'],
    ['db query', 'supabase db query --linked "select 1"'],
    ['db reset', 'supabase db reset --linked'],
    ['db pull', 'supabase db pull'],
    ['db diff', 'supabase db diff --linked'],
    ['migration up', 'supabase migration up --linked'],
    ['a migration repair', 'supabase migration repair --status applied 1'],
    ['psql', `psql "${DIRECT_URL}" -f supabase/migrations/x.sql`],
  ])('does not read %s as a push', (_, command) => {
    expect(pushesOf(command)).toEqual([]);
  });
});

describe('isRealPush and isCreditedPush', () => {
  it.each<[label: string, pushed: DbPush, real: boolean, credited: boolean]>([
    ['a plain push', push(), true, true],
    ['a push with --yes', push({ yes: true }), true, true],
    ['a dry run', push({ dryRun: true }), false, false],
    ['an explicitly local push', push({ explicitlyLocal: true }), false, false],
    ['a failed push', push({ failed: true }), true, false],
    ['an up-to-date push', push({ upToDate: true }), true, false],
    [
      'a dry run that failed',
      push({ dryRun: true, failed: true }),
      false,
      false,
    ],
  ])('classifies %s', (_, pushed, real, credited) => {
    expect(isRealPush(pushed)).toBe(real);
    expect(isCreditedPush(pushed)).toBe(credited);
  });
});

describe('describePushes', () => {
  const list = (kinds: string[]) => new Intl.ListFormat('en').format(kinds);

  it('says no push ran when there is none', () => {
    expect(describePushes([])).toBe('no supabase db push ran');
  });

  it('words each lone kind of push differently', () => {
    const notes = [
      describePushes([push({ dryRun: true })]),
      describePushes([push({ explicitlyLocal: true })]),
      describePushes([push({ upToDate: true })]),
      describePushes([push({ failed: true })]),
    ];
    expect(new Set(notes).size).toBe(4);
    expect(notes.slice(0, 3)).toEqual([
      'only dry-run supabase db push ran',
      'only local supabase db push ran',
      'only up-to-date supabase db push ran',
    ]);
    expect(notes[3]).toMatch(/^only failed supabase db push ran/);
  });

  it('names each kind of push that ran, in a fixed order', () => {
    expect(
      describePushes([
        push({ explicitlyLocal: true }),
        push({ dryRun: true, order: 1 }),
      ])
    ).toBe('only dry-run and local supabase db push ran');
    expect(
      describePushes([
        push({ explicitlyLocal: true }),
        push({ failed: true, failure: WRAPPER_CONFLICT, order: 1 }),
      ])
    ).toBe(
      `only local and failed supabase db push ran; first failure: "${WRAPPER_CONFLICT}"`
    );
    expect(
      describePushes([
        push({ upToDate: true }),
        push({ failed: true, failure: 'exit 1', order: 1 }),
      ])
    ).toBe(
      'only up-to-date and failed supabase db push ran; first failure: "exit 1"'
    );
  });

  it('lists all four kinds when all four ran', () => {
    expect(
      describePushes([
        push({ dryRun: true }),
        push({ explicitlyLocal: true, order: 1 }),
        push({ upToDate: true, order: 2 }),
        push({ failed: true, failure: 'exit 1', order: 3 }),
      ])
    ).toBe(
      `only ${list(['dry-run', 'local', 'up-to-date', 'failed'])} supabase db push ran; first failure: "exit 1"`
    );
  });

  it('quotes the failure of the first failed push', () => {
    expect(
      describePushes([
        push({ failed: true, failure: WRAPPER_CONFLICT }),
        push({ failed: true, failure: 'Cannot find project ref.', order: 1 }),
      ])
    ).toBe(
      `only failed supabase db push ran; first failure: "${WRAPPER_CONFLICT}"`
    );
  });

  it('quotes nothing when the failed push showed no line', () => {
    expect(describePushes([push({ failed: true })])).toBe(
      'only failed supabase db push ran'
    );
  });

  it('quotes the failure of a push that was not a dry run', () => {
    expect(
      describePushes([
        push({ dryRun: true, failed: true, failure: 'dry-run boom' }),
        push({ failed: true, failure: 'exit 1', order: 1 }),
      ])
    ).toBe(
      'only dry-run and failed supabase db push ran; first failure: "exit 1"'
    );
  });

  it('quotes the failure of a push that was not local', () => {
    expect(
      describePushes([
        push({ explicitlyLocal: true, failed: true, failure: 'local boom' }),
        push({ failed: true, failure: 'exit 1', order: 1 }),
      ])
    ).toBe(
      'only local and failed supabase db push ran; first failure: "exit 1"'
    );
  });
});

describe('checkPushed', () => {
  it('keeps the check name stable for the results dashboard', () => {
    expect(PUSH_CHECK_NAME).toBe('the agent pushed with supabase db push');
  });

  it('passes for a credited push', () => {
    expect(checkPushed([push()])).toEqual({
      name: PUSH_CHECK_NAME,
      passed: true,
    });
  });

  it.each([
    ['push --linked --yes', 'supabase db push --linked --yes'],
    ['a bare push', 'supabase db push'],
    ['a piped answer through npx', 'echo y | npx supabase db push'],
    ['push --remote --yes', 'supabase db push --remote --yes'],
    ['a project ref', `supabase db push --project-ref ${HOSTED_REF}`],
    ['a pinned runner', 'npx -y supabase@2.122.0 db push --linked'],
    ['a remote --db-url', `supabase db push --db-url "${POOLER_URL}"`],
    ['--remote=<ref>', `supabase db push --remote=${HOSTED_REF} --yes`],
    ['--dry-run=false', 'supabase db push --dry-run=false'],
  ])('passes for %s', (_, command) => {
    expect(checkPushed(pushesOf(command))).toMatchObject({
      name: PUSH_CHECK_NAME,
      passed: true,
    });
  });

  it('passes for a push that printed its success', () => {
    expect(
      checkPushed(
        pushesOf(shellCall(PUSH, { result: 'Finished supabase db push.' }))
      )
    ).toEqual({ name: PUSH_CHECK_NAME, passed: true });
  });

  it.each([
    ['an explicitly local push', 'supabase db push --local'],
    ['a loopback --db-url push', `supabase db push --db-url "${LOCAL_URL}"`],
    [
      'a loopback --remote=<url> push',
      `supabase db push --remote="${LOCAL_URL}"`,
    ],
  ])('fails for %s that applied the migration', (_, command) => {
    expect(
      checkPushed(pushesOf(shellCall(command, { result: APPLIED })))
    ).toEqual({
      name: PUSH_CHECK_NAME,
      passed: false,
      notes: 'only local supabase db push ran',
    });
  });

  it.each([
    ['text output', UP_TO_DATE],
    ['JSON output', UP_TO_DATE_JSON],
  ])('fails for a push with nothing to apply, in %s', (_, result) => {
    expect(
      checkPushed(pushesOf(shellCall('supabase db push', { result })))
    ).toEqual({
      name: PUSH_CHECK_NAME,
      passed: false,
      notes: 'only up-to-date supabase db push ran',
    });
  });

  it.each<[label: string, calls: Call[]]>([
    [
      'a failed --linked push, then a bare push that applied',
      [
        shellCall('supabase db push --linked', { error: WRAPPER_CONFLICT }),
        shellCall('supabase db push --yes', { result: APPLIED }),
      ],
    ],
    [
      'a push that applied, then an up-to-date re-push',
      [
        shellCall('supabase db push', { result: APPLIED }),
        shellCall('supabase db push', { result: UP_TO_DATE }),
      ],
    ],
    [
      'an up-to-date push, then a push that applied',
      [
        shellCall('supabase db push', { result: UP_TO_DATE }),
        shellCall('supabase db push', { result: APPLIED }),
      ],
    ],
    [
      'a local push, then a push to the hosted project that applied',
      [
        shellCall('supabase db push --local', { result: APPLIED }),
        shellCall(PUSH, { result: APPLIED }),
      ],
    ],
    [
      'a dry run, then the real push',
      ['supabase db push --dry-run --linked', PUSH],
    ],
    [
      'a successful push, then a failed one',
      [PUSH, failedShellCall('supabase db push --linked')],
    ],
  ])('passes for %s', (_, calls) => {
    expect(checkPushed(pushesOf(...calls))).toEqual({
      name: PUSH_CHECK_NAME,
      passed: true,
    });
  });

  it('fails for a push whose tool call errored', () => {
    expect(checkPushed(pushesOf(failedShellCall(PUSH)))).toEqual({
      name: PUSH_CHECK_NAME,
      passed: false,
      notes: expect.stringContaining('failed'),
    });
  });

  it.each(CLI_FAILURES)(
    'fails for a piped push whose output shows %s',
    (_, result) => {
      expect(
        checkPushed(
          pushesOf(shellCall('supabase db push 2>&1 | tail -20', { result }))
        ).passed
      ).toBe(false);
    }
  );

  it('fails when a dry run is followed by a push that failed', () => {
    expect(
      checkPushed(pushesOf('supabase db push --dry-run', failedShellCall(PUSH)))
        .passed
    ).toBe(false);
  });

  it('quotes the first failure in the notes', () => {
    expect(
      checkPushed(
        pushesOf(
          shellCall('supabase db push --linked', { error: WRAPPER_CONFLICT })
        )
      )
    ).toEqual({
      name: PUSH_CHECK_NAME,
      passed: false,
      notes: `only failed supabase db push ran; first failure: "${WRAPPER_CONFLICT}"`,
    });
  });

  it('words the notes exactly as describePushes does', () => {
    const pushes = [push({ dryRun: true }), push({ upToDate: true, order: 1 })];
    expect(checkPushed(pushes)).toEqual({
      name: PUSH_CHECK_NAME,
      passed: false,
      notes: describePushes(pushes),
    });
  });

  it.each([
    ['no commands', []],
    ['only a dry run', ['supabase db push --dry-run']],
    ['only dry runs', ['supabase db push --dry-run --linked --yes']],
    ['only migration up', ['supabase migration up --linked']],
    [
      'the migration run through db query and then repaired',
      [
        'supabase db query --linked -f supabase/migrations/20261027090000_drop_legacy_coupons.sql',
        'supabase migration repair --status applied 20261027090000',
      ],
    ],
    ['only db reset', ['supabase db reset --linked --yes']],
    ['only a dump', ['supabase db dump -f backup.sql']],
    ['only a help request', ['supabase db push --help']],
    ['only an echoed command line', ['echo "supabase db push --linked --yes"']],
    [
      'the migration applied through psql',
      [
        `psql "${DIRECT_URL}" -f supabase/migrations/20261027090000_drop_legacy_coupons.sql`,
      ],
    ],
  ])('fails with %s, saying no db push ran', (_, commands) => {
    expect(checkPushed(pushesOf(...commands))).toEqual({
      name: PUSH_CHECK_NAME,
      passed: false,
      notes: expect.stringMatching(/push/i),
    });
  });
});
